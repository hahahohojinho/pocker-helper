import { estimateSubsetEquities } from "../called-equity";
import { defaultFoldEquity, estimateActionEvs } from "../decision-ev";
import { defaultMultiwayFolds } from "../multiway-ev";
import { postflopOrder, type PostflopActionType } from "../postflop-machine";
import { calculateRangeEquity } from "../range-equity";
import { conditionRangeOnPostflop, inferRangeFromPreflop } from "../range-model";
import { buildMultiwaySolveRequest, MULTIWAY_MAX_PLAYERS, streetStartPotLayers, type MultiwaySolveRequest } from "../wasm-solver/multiway-request";
import { getSolverPreset } from "../solver-presets";
import { allStartingHands } from "../strategy-data";
import { BOARD_COUNT, postflopSetup, preflopState, SLOT_POSITIONS, type HandTurn, type SelfPlayHand } from "./hand-state";
import { streetStartRange, streetStartSeats, type PostflopAdvice, type SizeDetail } from "./postflop-advice";
import { postflopPresets } from "./sizing";

type PostflopTurn = Extract<HandTurn, { kind: "postflop" }>;
/** Same sample sizes as the postflop panel: about +-0.65%p equity error, ~0.2 s for a 6-way spot. */
const EQUITY_ITERATIONS = 20_000;
const HEADS_UP_CALLED_ITERATIONS = 10_000;
const MULTIWAY_SUBSET_ITERATIONS = 5000;
/** Weight given to hands added when inferred ranges are too narrow to deal together. */
const WIDEN_WEIGHT = 0.05;
/** calculateRangeEquity's messages for ranges that cannot be dealt together (src/lib/range-equity.ts). */
const DEAL_FAILURE = /상대 콤보/;

/** The range plus every other starting hand at a small weight, so several narrow ranges can always be dealt. */
function widenRange(rangeText: string) {
  const present = new Set(rangeText.split(",").map(entry => entry.split(":")[0].trim()));
  return [rangeText, ...allStartingHands.filter(hand => !present.has(hand)).map(hand => `${hand}:${WIDEN_WEIGHT}`)].filter(Boolean).join(",");
}

/**
 * Equity against the opponents' ranges. Off-model actions can collapse inferred ranges to a few hands (several seats
 * all "holding" the same pair), which cannot be dealt together; the ranges are then widened and the answer says so.
 */
function rangesAndEquity(hole: string[], board: string[], ranges: string[]) {
  try {
    return { ranges, equity: calculateRangeEquity(hole, board, ranges, EQUITY_ITERATIONS).equity, widened: false };
  } catch (error) {
    // Only a deal failure (opponent combos that collide) is fixed by widening; bad input is a real error.
    if (!(error instanceof Error) || !DEAL_FAILURE.test(error.message)) throw error;
    const widened = ranges.map(widenRange);
    return { ranges: widened, equity: calculateRangeEquity(hole, board, widened, EQUITY_ITERATIONS).equity, widened: true };
  }
}

/** An opponent's range now: preflop inference conditioned on all of its postflop actions so far (public only). */
function currentRange(hand: SelfPlayHand, turn: PostflopTurn, seat: number) {
  const preflop = inferRangeFromPreflop({ actions: hand.preflop, seat, position: SLOT_POSITIONS[seat], stack: hand.startStacks[seat], tableSize: 6 }).text;
  const actions = hand.postflop.filter(action => action.seat === seat).map(action => action.type);
  return conditionRangeOnPostflop({ rangeText: preflop, boardCodes: hand.board.slice(0, BOARD_COUNT[turn.street]), actions });
}

/**
 * Equity against each likely set of callers. Calling ranges are tighter than the inferred ones and can again be
 * impossible to deal together; the bet is then valued against the whole ranges (optimistic, as the panel labels it).
 */
function calledEquitiesOrNone(...args: Parameters<typeof estimateSubsetEquities>) {
  try { return estimateSubsetEquities(...args) ?? undefined; }
  catch (error) { console.warn("Called-range equity failed; valuing the bet against whole ranges", error); return undefined; }
}

/**
 * One-street model EV for the acting seat against every live opponent's range: check/call/fold plus each bet or raise
 * size the dock offers. Opponents fold at the break-even rate of each size. An approximation for spots the solvers
 * do not cover (3-way flops, 4+ players); it ignores later streets.
 */
export function modelAdvice(hand: SelfPlayHand, turn: PostflopTurn, actorHole: readonly [string, string]): PostflopAdvice {
  const { context, seat } = turn;
  const board = hand.board.slice(0, BOARD_COUNT[turn.street]);
  const hole = [...actorHole];
  const opponents = postflopSetup(hand).activeSeats.filter(other => other !== seat && !context.foldedSeats.has(other));
  const { ranges, equity, widened } = rangesAndEquity(hole, board, opponents.map(other => currentRange(hand, turn, other)));
  const heroCommitted = context.contributions.get(seat) ?? 0;
  const toCall = Math.max(0, context.currentBet - heroCommitted);
  const stack = context.remainingAtStart[seat] ?? 0;
  const maxCommitment = Math.min(stack, Math.max(0, ...opponents.map(other => context.remainingAtStart[other] ?? 0)));
  const foldable = opponents.map(other => !context.allInSeats.has(other));
  const callCaps = opponents.map(other => Math.max(0, (context.remainingAtStart[other] ?? 0) - context.currentBet));
  const owed = opponents.map(other => Math.max(0, Math.min(context.currentBet, context.remainingAtStart[other] ?? 0) - (context.contributions.get(other) ?? 0)));
  const base = { equity, pot: context.pot, toCall, heroCommitted, maxCommitment, opponents: opponents.length, foldable, callCaps, owed };
  const passive = estimateActionEvs({ ...base, betSize: 0 }).filter(row => row.action !== "bet" && row.action !== "raise");
  const aggressive: PostflopActionType = toCall > 0 ? "raise" : "bet";
  const canRaise = turn.allowed.includes(aggressive);
  const sized = canRaise ? postflopPresets(aggressive, context, seat).flatMap(preset => {
    const sizing = { ...base, betSize: preset.amount };
    const foldShare = defaultFoldEquity(sizing);
    const folds = defaultMultiwayFolds(foldShare, foldable);
    const iterations = opponents.length > 1 ? MULTIWAY_SUBSET_ITERATIONS : HEADS_UP_CALLED_ITERATIONS;
    // Equity when called: callers keep their stronger hands, so betting is not valued against the whole range.
    const calledEquities = foldShare > 0 && foldShare < 1 ? calledEquitiesOrNone(hole, board, ranges, folds, iterations) : undefined;
    const row = estimateActionEvs({ ...sizing, ...(calledEquities ? { calledEquities } : {}) }).find(item => item.action === aggressive);
    return row ? [{ action: aggressive, label: `${aggressive} ${preset.label}`, amount: preset.amount, frequency: 0, ev: row.ev }] : [];
  }) : [];
  const allowedPassive = passive.filter(row => turn.allowed.includes(row.action as PostflopActionType));
  const details: SizeDetail[] = [...allowedPassive.map(row => ({ action: row.action as PostflopActionType, label: row.action, frequency: 0, ev: row.ev })), ...sized];
  const best = details.reduce((top, row) => row.ev > top.ev ? row : top);
  const categories = [...new Set(details.map(row => row.action))].map(action => ({
    action, frequency: action === best.action ? 100 : 0, ev: Math.max(...details.filter(row => row.action === action).map(row => row.ev)),
  }));
  return {
    kind: "model", details,
    result: { source: "imported", actions: categories, bestAction: best.action, evSource: "solver" },
    note: `MODEL EV 근사: equity ${equity.toFixed(1)}% vs ${opponents.length}명 레인지, 상대는 사이즈별 break-even 비율로 폴드, 이후 스트리트 무시.${widened ? " 추정 레인지가 서로 겹쳐 모든 핸드를 낮은 비중으로 넣어 넓혔습니다." : ""}`,
  };
}

/** 3-way turn or river request for the native multiway solver; null when the street did not start 3-handed. */
export function multiwayRequest(hand: SelfPlayHand, turn: PostflopTurn, actorHole: readonly [string, string]): MultiwaySolveRequest | null {
  if (turn.street === "flop") return null;
  const startSeats = streetStartSeats(hand, turn.street);
  if (startSeats.length !== MULTIWAY_MAX_PLAYERS) return null;
  // Every seat still in the hand, in postflop order (all-in seats included with a zero stack), as in the panel.
  const ordered = postflopOrder(SLOT_POSITIONS, preflopState(hand).foldedSeats).filter(slot => startSeats.includes(slot));
  if (ordered.filter(slot => (turn.context.remainingAtStart[slot] ?? 0) > 0).length < 2) return null;
  const actor = { seat: turn.seat, hole: actorHole };
  const preset = getSolverPreset("multiway", turn.street);
  const committed = new Map(SLOT_POSITIONS.map((_, slot) => [slot, Math.max(0, hand.startStacks[slot] - (turn.context.remainingAtStart[slot] ?? 0))]));
  return buildMultiwaySolveRequest({
    board: hand.board.slice(0, BOARD_COUNT[turn.street]), heroHole: [...actorHole], heroIndex: ordered.indexOf(turn.seat),
    players: ordered.map(slot => ({ range: streetStartRange(hand, turn.street, slot, actor), stack: turn.context.remainingAtStart[slot] ?? 0 })),
    pot: turn.context.potBefore, potLayers: streetStartPotLayers({ committed, players: ordered, pot: turn.context.potBefore }),
    history: turn.context.actions.map(action => ({ player: ordered.indexOf(action.seat), action: action.type, amount: action.amount })),
    iterations: preset.iterations, betPercent: preset.tree.betPercent, raisePercent: preset.tree.raisePercent, timeBudgetMs: preset.timeBudgetMs,
  });
}
