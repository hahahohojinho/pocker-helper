import { Action as RecommendationAction, Position, Recommendation, recommendPreflop } from "./preflop";
import { lookupStrategy, nearestStackBucket, type PreflopSpotContext } from "./strategy-data";

export type Street = "preflop" | "flop" | "turn" | "river";
export type PlayerActionType = "fold" | "check" | "limp" | "open" | "call" | "3bet" | "4bet" | "5bet";

export interface PlayerAction {
  id: string;
  street: Street;
  seat: number;
  position: Position;
  type: PlayerActionType;
  amount: number;
  implicit?: boolean;
}

export type PreflopScenario = "unopened" | "single-open" | "open-with-callers" | "facing-3bet" | "facing-4bet";

export function classifyPreflop(actions: PlayerAction[]): PreflopScenario {
  const active = actions.filter(action => action.type !== "fold");
  if (active.some(action => action.type === "4bet")) return "facing-4bet";
  if (active.some(action => action.type === "3bet")) return "facing-3bet";
  const opened = active.some(action => action.type === "open");
  const callers = active.filter(action => action.type === "call").length;
  if (opened && callers > 0) return "open-with-callers";
  if (opened) return "single-open";
  return "unopened";
}

export function derivePreflopSpotContext(actions:PlayerAction[]):PreflopSpotContext{
  const active=actions.filter(action=>action.type!=="fold");
  const opener=active.find(action=>action.type==="open");
  const callerPositions=[...new Set(active.filter(action=>action.type==="call").map(action=>action.position))];
  const latestAggression=[...active].reverse().find(action=>["open","3bet","4bet","5bet"].includes(action.type));
  return {openerPosition:opener?.position,callerPositions,actionSize:latestAggression?.amount};
}

const scenarioLabels: Record<PreflopScenario, string> = {
  unopened: "미오픈 팟",
  "single-open": "단일 오픈 대응",
  "open-with-callers": "오픈 + 콜러 대응",
  "facing-3bet": "3-bet 대응",
  "facing-4bet": "4-bet 대응",
};

function normalize(values: Record<RecommendationAction, number>) {
  const total = Object.values(values).reduce((sum, value) => sum + Math.max(0, value), 0);
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Math.round(Math.max(0, value) / total * 100)])) as Record<RecommendationAction, number>;
}

export function recommendFromHistory(input: {
  heroPosition: Position;
  hand: string;
  effectiveStack: number;
  actions: PlayerAction[];
}): Recommendation & { scenario: PreflopScenario; spotContext:PreflopSpotContext;strategySource:string;scenarioLabel: string; primaryDisplay:string; displayFrequencies:{action:string;frequency:number}[] } {
  const scenario = classifyPreflop(input.actions);
  const spotContext=derivePreflopSpotContext(input.actions);
  const aggressor = [...input.actions].reverse().find(action => ["open", "3bet", "4bet"].includes(action.type));
  const base = recommendPreflop({
    heroPosition: input.heroPosition,
    villainPosition: aggressor?.position ?? "BB",
    hand: input.hand,
    openSize: aggressor?.amount || 2.5,
    effectiveStack: input.effectiveStack,
  });
  const mix=lookupStrategy({hand:input.hand,position:input.heroPosition,stack:input.effectiveStack,scenario,...spotContext});
  const frequencies = normalize({ Fold: mix.fold, Call: mix.passive, "3-bet": mix.aggressive });
  const primary = Object.entries(frequencies).sort((a, b) => b[1] - a[1])[0][0] as RecommendationAction;
  const labels=scenario==="unopened"?{Fold:"Fold",Call:"Limp","3-bet":"Open"}:scenario==="facing-3bet"?{Fold:"Fold",Call:"Call","3-bet":"4-bet"}:scenario==="facing-4bet"?{Fold:"Fold",Call:"Call","3-bet":"5-bet / All-in"}:{Fold:"Fold",Call:"Call","3-bet":"3-bet"};
  const primaryDisplay=labels[primary];
  return {
    ...base,
    primary,
    frequencies,
    scenario,
    spotContext,
    strategySource:mix.source,
    scenarioLabel: scenarioLabels[scenario],
    primaryDisplay,
    displayFrequencies:(Object.keys(frequencies) as RecommendationAction[]).map(action=>({action:labels[action],frequency:frequencies[action]})),
    summary: `${scenarioLabels[scenario]} · ${nearestStackBucket(input.effectiveStack)}BB 데이터 구간에서 ${input.hand.toUpperCase()}의 우선 액션은 ${primaryDisplay}입니다.`,
  };
}
