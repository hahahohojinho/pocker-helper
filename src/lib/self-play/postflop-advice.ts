import { conditionRangeOnPostflop, ensureComboInRange, inferRangeFromPreflop } from "../range-model";
import { parseSolverResult, type SolverResult } from "../solver-adapter";
import { getSolverPreset, laterStreetsCheckedDown } from "../solver-presets";
import type { PostflopContext } from "../postflop-hand-state";
import type { PostflopActionType } from "../postflop-machine";
import { buildWasmSolveRequest, MAX_TURN_AGGRESSIONS_WITH_RIVER, type WasmSolveRequest } from "../wasm-solver/request";
import { BOARD_COUNT, postflopSetup, SLOT_POSITIONS, type HandTurn, type PostflopStreet, type SelfPlayHand } from "./hand-state";

export type SolveBackend = "native" | "wasm";
type PostflopTurn = Extract<HandTurn, { kind: "postflop" }>;
const STREETS: PostflopStreet[] = ["flop", "turn", "river"];

/** Seats that started this street (a fold on an earlier street removes a seat; one on this street is history). */
export function streetStartSeats(hand: SelfPlayHand, street: PostflopStreet): number[] {
  const { activeSeats } = postflopSetup(hand);
  const index = STREETS.indexOf(street);
  return activeSeats.filter(seat => !hand.postflop.some(action => action.seat === seat && action.type === "fold" && STREETS.indexOf(action.street) < index));
}

/**
 * Range a seat holds at the start of the street, from public information only: its preflop actions, its earlier
 * postflop actions, and the board. The acting seat's own combo is kept in its range so the solver can answer for it.
 */
export function streetStartRange(hand: SelfPlayHand, street: PostflopStreet, seat: number, actor: { seat: number; hole: readonly [string, string] }): string {
  const preflop = inferRangeFromPreflop({ actions: hand.preflop, seat, position: SLOT_POSITIONS[seat], stack: hand.startStacks[seat], tableSize: 6 }).text;
  const earlier = hand.postflop.filter(action => action.seat === seat && action.street !== street).map(action => action.type);
  const range = conditionRangeOnPostflop({ rangeText: preflop, boardCodes: hand.board.slice(0, BOARD_COUNT[street]), actions: earlier });
  return seat === actor.seat ? ensureComboInRange(range, [...actor.hole]) : range;
}

/**
 * The heads-up DCFR request for the acting seat, built the way the postflop panel builds it. `actorHole` is the only
 * hole-card input: other seats' cards never reach the solver. Null when the street did not start heads-up.
 */
export function headsUpRequest(hand: SelfPlayHand, turn: PostflopTurn, actorHole: readonly [string, string], backend: SolveBackend, iterationCostNs?: number): WasmSolveRequest | null {
  const seats = streetStartSeats(hand, turn.street);
  if (seats.length !== 2) return null;
  const { order } = postflopSetup(hand);
  const oopSeat = order.find(seat => seats.includes(seat));
  const ipSeat = seats.find(seat => seat !== oopSeat);
  if (oopSeat === undefined || ipSeat === undefined) return null;
  const actor = { seat: turn.seat, hole: actorHole };
  const preset = getSolverPreset(backend, turn.street);
  return buildWasmSolveRequest({
    board: hand.board.slice(0, BOARD_COUNT[turn.street]), heroHole: [...actorHole],
    oopRange: streetStartRange(hand, turn.street, oopSeat, actor), ipRange: streetStartRange(hand, turn.street, ipSeat, actor),
    pot: turn.context.potBefore, stacks: { oop: turn.context.remainingAtStart[oopSeat] ?? 0, ip: turn.context.remainingAtStart[ipSeat] ?? 0 },
    history: turn.context.actions.map(action => ({ role: action.seat === oopSeat ? "oop" : "ip", action: action.type, amount: action.amount })),
    iterations: preset.iterations, betPercent: preset.tree.betPercent, raisePercent: preset.tree.raisePercent, timeBudgetMs: preset.timeBudgetMs,
    ...(preset.laterStreets ? { laterStreets: preset.laterStreets } : {}),
    ...(preset.allInPotRatio === undefined ? {} : { allInPotRatio: preset.allInPotRatio }),
    ...(backend === "wasm" && iterationCostNs !== undefined ? { iterationCostNs } : {}),
  });
}

/** Cache key: the solved spot without the machine-specific iteration planning. */
export function adviceKey(request: WasmSolveRequest): string {
  return JSON.stringify({ ...request, iterationCostNs: undefined });
}

/** True when the solved tree had no betting after this street, so later streets were checked down. */
export function checkedDown(backend: SolveBackend, turn: PostflopTurn): boolean {
  const aggressions = turn.context.actions.filter(action => action.type === "bet" || action.type === "raise").length;
  return laterStreetsCheckedDown(backend, turn.street) || (turn.street === "turn" && aggressions > MAX_TURN_AGGRESSIONS_WITH_RIVER);
}

/** One action or size at the node; `amount` (street total, BB) is given when the label alone does not price it. */
export interface SizeDetail { action: PostflopActionType; label: string; frequency: number; ev: number; amount?: number; }
/** "solver": equilibrium frequencies and EVs; "model": EV estimates only (frequencies are not meaningful). */
export interface PostflopAdvice { kind: "solver" | "model"; result: SolverResult; details: SizeDetail[]; note?: string; }

const isAction = (value: unknown): value is PostflopActionType => typeof value === "string" && ["fold", "check", "call", "bet", "raise"].includes(value);

/** The normalized solver JSON plus its per-size rows (absent from older adapters; grading then uses categories). */
export function parsePostflopAdvice(raw: string): PostflopAdvice {
  const result = parseSolverResult(raw);
  const data = JSON.parse(raw) as { details?: unknown; note?: unknown };
  const details = Array.isArray(data.details) ? data.details.flatMap(row => {
    const item = row as Record<string, unknown>;
    return isAction(item.action) && typeof item.label === "string" && typeof item.frequency === "number" && typeof item.ev === "number"
      ? [{ action: item.action, label: item.label, frequency: item.frequency, ev: item.ev }] : [];
  }) : [];
  return { kind: "solver", result, details, ...(typeof data.note === "string" ? { note: data.note } : {}) };
}

/** Street-total BB a solver size label stands for at this node ("bet 33%", "bet 3/2", "bet 2x", "allin"); null if unknown. */
export function labelAmount(label: string, context: PostflopContext, seat: number): number | null {
  const stack = context.remainingAtStart[seat] ?? 0;
  if (label === "allin") return stack;
  const match = /^bet (\d+)(%|x|\/(\d+))$/.exec(label);
  if (!match) return null;
  const numerator = Number(match[1]);
  const fraction = match[2] === "%" ? numerator / 100 : match[2] === "x" ? numerator : numerator / Number(match[3]);
  const toCall = context.currentBet - (context.contributions.get(seat) ?? 0);
  // dcfr-solver: a bet is a pot fraction; a raise adds the fraction of the pot after calling on top of the bet faced.
  const amount = context.currentBet > 0 ? context.currentBet + fraction * (context.pot + toCall) : fraction * context.pot;
  return Math.min(stack, Math.round(amount * 100) / 100);
}

export interface PostflopGrade {
  chosenLabel: string;
  chosenEv: number;
  /** How often the solver plays the chosen size (0-1). */
  chosenFrequency: number;
  bestLabel: string;
  bestEv: number;
  /** BB given up against the best option at this node (never negative). */
  evLoss: number;
  /** The chosen bet or raise was graded against a size-less category (e.g. the 3-way solver), not its own size. */
  sizeApprox: boolean;
}

/**
 * EV loss of a chosen action against the solver's best option at the node. A bet or raise is matched to the nearest
 * solved size; sizes off the tree are therefore graded as that nearest size.
 */
export function gradePostflop(advice: PostflopAdvice, type: PostflopActionType, amount: number, context: PostflopContext, seat: number): PostflopGrade | null {
  const rows: SizeDetail[] = advice.details.length ? advice.details
    : advice.result.actions.flatMap(action => action.ev === undefined ? [] : [{ action: action.action, label: action.action, frequency: action.frequency / 100, ev: action.ev }]);
  const candidates = rows.filter(row => row.action === type);
  if (!candidates.length) return null;
  // Category-only rows (no size in the label, e.g. the 3-way solver) match any size of that action.
  const rowAmount = (row: SizeDetail) => row.amount ?? (row.label === row.action ? amount : labelAmount(row.label, context, seat));
  const distance = (row: SizeDetail) => type === "bet" || type === "raise" ? Math.abs((rowAmount(row) ?? Number.POSITIVE_INFINITY) - amount) : 0;
  const chosen = candidates.reduce((nearest, row) => distance(row) < distance(nearest) ? row : nearest);
  // No solved size could be priced (an unknown label format): leave the decision ungraded rather than guess.
  if (!Number.isFinite(distance(chosen))) return null;
  const best = rows.reduce((top, row) => row.ev > top.ev ? row : top);
  const sizeApprox = (type === "bet" || type === "raise") && chosen.amount === undefined && chosen.label === chosen.action;
  return { chosenLabel: chosen.label, chosenEv: chosen.ev, chosenFrequency: chosen.frequency, bestLabel: best.label, bestEv: best.ev, evLoss: Math.max(0, best.ev - chosen.ev), sizeApprox };
}
