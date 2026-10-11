import type { WasmHistoryAction, WasmSolveRequest } from "../wasm-solver/request";
import { CHIPS_PER_BB } from "../wasm-solver/request";
import { canonicalFlop, mapCards } from "./canonical";
import { FREQUENCY_SCALE, type ActionCategory, type FlopIndex, type FlopScenario, type FlopSolution, type Fraction } from "./format";

export type FlopLibraryMiss = "not-flop" | "line" | "scenario" | "board" | "stale" | "node" | "hero";
export interface FlopLibraryMatch { scenario: FlopScenario; board: string; nodeKey: string; hero: string; }

/** Explains a miss in the UI; the live solver answers instead. */
export const MISS_LABELS: Record<FlopLibraryMiss, string> = {
  "not-flop": "플랍이 아님",
  line: "라이브러리에 없는 액션 라인",
  scenario: "레인지, 팟, 스택, 사이즈 중 사전 계산과 다른 값이 있음",
  board: "아직 계산하지 않은 플랍",
  stale: "이전 설정으로 계산된 파일 (라이브러리 재생성 필요)",
  node: "이 보드에 없는 노드",
  hero: "Hero 핸드가 저장된 레인지에 없음",
};

const sameFractions = (left: Fraction[][], right: Fraction[][]) => JSON.stringify(left) === JSON.stringify(right);

/** "" (OOP root), "x" (IP after a check), "b1/2" or "x,b1/2" (facing that bet); null for any other line. */
export function historyKey(history: readonly WasmHistoryAction[]): string | null {
  const steps = history.map(step => step.action === "check" ? "x" : step.action === "bet" ? `b${step.size[0]}/${step.size[1]}` : null);
  if (steps.some(step => step === null) || steps.length > 2) return null;
  const key = steps.join(",");
  return ["", "x"].includes(key) || /^(x,)?b\d+\/\d+$/.test(key) ? key : null;
}

/** Finds the stored scenario and canonical flop that answer exactly this solve request. */
export function matchFlopLibrary(index: FlopIndex, request: WasmSolveRequest): FlopLibraryMatch | { miss: FlopLibraryMiss } {
  if (request.board.length !== 6) return { miss: "not-flop" };
  const nodeKey = historyKey(request.history);
  if (nodeKey === null) return { miss: "line" };
  const scenario = index.scenarios.find(item => item.pot === request.pot && item.stacks[0] === request.stacks[0] && item.stacks[1] === request.stacks[1]
    && item.maxRaises === request.maxRaises && sameFractions(item.betSizes, request.betSizes) && item.oopRange === request.oopRange && item.ipRange === request.ipRange);
  if (!scenario) return { miss: "scenario" };
  const { board, suitMap } = canonicalFlop(request.board.match(/.{2}/g) ?? []);
  if (!scenario.flops.includes(board)) return { miss: "board" };
  return { scenario, board, nodeKey, hero: mapCards(request.hero.match(/.{2}/g) ?? [], suitMap).join("") };
}

interface Grouped { category: ActionCategory; frequency: number; weightedEv: number; bestEv: number; }

function groupHeroActions(solution: FlopSolution, match: FlopLibraryMatch): { miss: FlopLibraryMiss } | { groups: Grouped[]; unreached: boolean } {
  const node = solution.nodes[match.nodeKey];
  if (!node) return { miss: "node" };
  const combos = solution.combos[node.player];
  const reversed = `${match.hero.slice(2)}${match.hero.slice(0, 2)}`;
  const comboIndex = combos.findIndex(combo => combo === match.hero || combo === reversed);
  if (comboIndex < 0) return { miss: "hero" };
  const groups = new Map<ActionCategory, Grouped>();
  node.actions.forEach((action, actionIndex) => {
    const offset = comboIndex * node.actions.length + actionIndex;
    const frequency = node.freq[offset] / FREQUENCY_SCALE, ev = node.ev[offset] / CHIPS_PER_BB;
    const previous = groups.get(action.category) ?? { category: action.category, frequency: 0, weightedEv: 0, bestEv: Number.NEGATIVE_INFINITY };
    groups.set(action.category, { ...previous, frequency: previous.frequency + frequency, weightedEv: previous.weightedEv + frequency * ev, bestEv: Math.max(previous.bestEv, ev) });
  });
  return { groups: [...groups.values()], unreached: node.unreached.includes(comboIndex) };
}

/** Normalized solver JSON (as from a live solve) for Hero's combo, or the reason it cannot be answered. */
export function answerFromSolution(solution: FlopSolution, match: FlopLibraryMatch): string | { miss: FlopLibraryMiss } {
  // A file solved for an older manifest (other ranges or tree) must never answer for the current spec.
  if (solution.build.specHash !== match.scenario.specHash) return { miss: "stale" };
  const grouped = groupHeroActions(solution, match);
  if ("miss" in grouped) return grouped;
  // A category the hand never takes has no frequency-weighted EV; its best concrete size is shown instead.
  const strategy = grouped.groups.map(group => ({ action: group.category, frequency: group.frequency, ev: group.frequency > 0 ? group.weightedEv / group.frequency : group.bestEv }));
  const best = strategy.reduce((top, item) => item.frequency > top.frequency ? item : top);
  return JSON.stringify({
    source: "flop-library", strategy, best_action: best.action,
    exploitability: solution.build.exploitability, iterations: solution.build.iterations,
    scenario: match.scenario.label, generatedAt: match.scenario.generatedAt,
    ...(grouped.unreached ? { note: "균형 전략에서 Hero 핸드는 이 라인에 도달하지 않습니다. 빈도 대신 EV가 가장 높은 액션을 표시합니다." } : {}),
  });
}
