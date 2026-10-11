import type { PlayerAction } from "../game-state";
import type { Position } from "../preflop";
import { deriveBettingState } from "../preflop-machine";
import type { TableSize } from "../preflop-packs";
import { postflopOrder } from "../postflop-machine";
import { inferRangeFromPreflop } from "../range-model";
import { getSolverPreset } from "../solver-presets";
import { buildWasmSolveRequest } from "../wasm-solver/request";
import { enumerateCanonicalFlops } from "./canonical";
import type { FlopScenario } from "./format";

/** A single-raised pot the library precomputes: everyone else folds, the caller calls the open. */
export interface ScenarioDef { id: string; label: string; tableSize: TableSize; stack: number; opener: Position; caller: Position; openSize: number; }

/** Seat order as the table helper lays it out; seat indexes feed the recorded actions. */
const SEATS: Record<TableSize, Position[]> = { 6: ["BTN", "SB", "BB", "UTG", "HJ", "CO"], 8: ["BTN", "SB", "BB", "UTG", "UTG+1", "MP", "HJ", "CO"] };
const ACTION_ORDER: Record<TableSize, Position[]> = { 6: ["UTG", "HJ", "CO", "BTN", "SB", "BB"], 8: ["UTG", "UTG+1", "MP", "HJ", "CO", "BTN", "SB", "BB"] };

/** First priority: the most common heads-up pots at 6-max 100bb, with the solved packs' open sizes. */
export const SCENARIO_DEFS: readonly ScenarioDef[] = [
  { id: "6max-100bb-srp-btn-bb", label: "BTN vs BB SRP 100bb", tableSize: 6, stack: 100, opener: "BTN", caller: "BB", openSize: 2.5 },
  { id: "6max-100bb-srp-co-bb", label: "CO vs BB SRP 100bb", tableSize: 6, stack: 100, opener: "CO", caller: "BB", openSize: 2.5 },
  { id: "6max-100bb-srp-sb-bb", label: "SB vs BB SRP 100bb", tableSize: 6, stack: 100, opener: "SB", caller: "BB", openSize: 3.5 },
];

/** The preflop actions the table helper records for this line, including the implicit folds of skipped seats. */
export function scenarioActions(def: ScenarioDef): PlayerAction[] {
  const seats = SEATS[def.tableSize];
  const act = (position: Position, type: PlayerAction["type"], amount: number, implicit = false): PlayerAction =>
    ({ id: `${position}-${type}`, street: "preflop", seat: seats.indexOf(position), position, type, amount, ...(implicit ? { implicit: true } : {}) });
  const order = ACTION_ORDER[def.tableSize];
  const openerAt = order.indexOf(def.opener), callerAt = order.indexOf(def.caller);
  return [
    ...order.slice(0, openerAt).map(position => act(position, "fold", 0, true)),
    act(def.opener, "open", def.openSize),
    ...order.slice(openerAt + 1, callerAt).map(position => act(position, "fold", 0, true)),
    act(def.caller, "call", def.openSize),
  ];
}

/**
 * The scenario exactly as the postflop panel would send it to the native solver: same ranges (inferred from the
 * installed preflop pack), pot, stacks, and flop bet tree. Flops and the spec hash are added by the library build.
 */
export function buildScenarioSpec(def: ScenarioDef, generatedAt: string): Omit<FlopScenario, "specHash"> {
  const seats = SEATS[def.tableSize];
  const actions = scenarioActions(def);
  const stacks = seats.map(() => def.stack);
  const preflop = deriveBettingState(actions, seats, stacks);
  const live = [def.opener, def.caller].map(position => seats.indexOf(position));
  const order = postflopOrder(seats, new Set([...preflop.foldedSeats, ...preflop.allInSeats]));
  const [oopSeat, ipSeat] = order.filter(seat => live.includes(seat));
  const range = (seat: number) => inferRangeFromPreflop({ actions, seat, position: seats[seat], stack: stacks[seat], tableSize: def.tableSize }).text;
  const remaining = (seat: number) => def.stack - (preflop.contributions.get(seat) ?? 0);
  const preset = getSolverPreset("native", "flop");
  // Any board and hero: only the pot, stacks, and tree encoding are taken from the request.
  const request = buildWasmSolveRequest({
    board: ["2c", "3d", "4h"], heroHole: ["5s", "6s"], oopRange: range(oopSeat), ipRange: range(ipSeat),
    pot: preflop.pot, stacks: { oop: remaining(oopSeat), ip: remaining(ipSeat) }, history: [],
    iterations: preset.iterations, betPercent: preset.tree.betPercent, raisePercent: preset.tree.raisePercent,
  });
  return {
    id: def.id, label: def.label, oop: seats[oopSeat], ip: seats[ipSeat], pot: request.pot, stacks: request.stacks,
    betSizes: request.betSizes, maxRaises: request.maxRaises, oopRange: request.oopRange, ipRange: request.ipRange, flops: [], generatedAt,
  };
}

/** What the generator reads: every scenario spec plus the flop classes, heaviest first. */
export function buildManifest(generatedAt: string) {
  return { scenarios: SCENARIO_DEFS.map(def => buildScenarioSpec(def, generatedAt)), flops: enumerateCanonicalFlops() };
}
