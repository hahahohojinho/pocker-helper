import type { PlayerActionType } from "../game-state";
import { availableActions, deriveBettingState, type BettingState } from "../preflop-machine";
import type { HandRecordV1 } from "./hand-record";
import type { HandEnd } from "./hand-replay";

/**
 * Every stat is a pair: n opportunities and x times taken, so later code can shrink small samples toward a prior.
 * The af_* stats count actions instead (n = x = count).
 */
export const STAT_KEYS = [
  "vpip", "pfr", "limp", "limp_fold_to_raise", "limp_call_raise", "limp_reraise", "three_bet", "fold_to_three_bet", "cold_call",
  "saw_flop", "flop_cbet", "fold_to_flop_cbet", "af_aggr", "af_call", "af_fold", "wtsd", "wsd",
] as const;
export type StatKey = typeof STAT_KEYS[number];
export interface StatEvent { stat: StatKey; n: number; x: number; }
/** Bump when a stat definition changes; stored hands are then re-derived from their records. */
export const STATS_VERSION = 1;

const raises: readonly PlayerActionType[] = ["open", "3bet", "4bet", "5bet"];
const voluntary: readonly PlayerActionType[] = ["limp", "call", ...raises];

class EventSink {
  readonly bySeat = new Map<number, StatEvent[]>();
  private readonly once = new Set<string>();
  add(seat: number, stat: StatKey, taken: boolean | number) {
    const x = typeof taken === "number" ? taken : taken ? 1 : 0;
    const n = typeof taken === "number" ? taken : 1;
    this.bySeat.set(seat, [...(this.bySeat.get(seat) ?? []), { stat, n, x }]);
  }
  /** Records only the first opportunity per seat and stat in a hand. */
  first(seat: number, stat: StatKey, taken: boolean) {
    const key = `${seat}:${stat}`;
    if (this.once.has(key)) return;
    this.once.add(key);
    this.add(seat, stat, taken);
  }
}

function preflopEvents(record: HandRecordV1, sink: EventSink) {
  const positions = record.seats.map(seat => seat.position);
  const stacks = record.seats.map(seat => seat.startStack);
  const acted = new Set<number>(), putIn = new Set<number>(), limped = new Set<number>();
  let opener: number | null = null;
  for (const [index, action] of record.preflop.entries()) {
    const prior = record.preflop.slice(0, index);
    const { raiseCount } = deriveBettingState(prior, positions, stacks);
    const { seat, type } = action;
    if (!acted.has(seat) && raiseCount === 0 && positions[seat] !== "BB") sink.first(seat, "limp", type === "limp");
    if (raiseCount === 1 && availableActions(prior, positions, seat, stacks).includes("3bet")) sink.first(seat, "three_bet", type === "3bet");
    // Blinds defending already have chips in, so their calls are not cold calls.
    if (raiseCount >= 1 && !putIn.has(seat) && positions[seat] !== "SB" && positions[seat] !== "BB") sink.first(seat, "cold_call", type === "call");
    if (raiseCount === 2 && opener === seat) sink.first(seat, "fold_to_three_bet", type === "fold");
    // Only the response to the isolation raise itself; facing a later 3-bet squeeze is a different spot.
    if (raiseCount === 1 && limped.has(seat)) {
      sink.first(seat, "limp_fold_to_raise", type === "fold");
      sink.first(seat, "limp_call_raise", type === "call");
      sink.first(seat, "limp_reraise", raises.includes(type));
    }
    acted.add(seat);
    if (voluntary.includes(type)) putIn.add(seat);
    if (type === "limp") limped.add(seat);
    if (type === "open") opener = seat;
  }
  for (const seat of record.seats) {
    // A big blind who never acted got a walk: there was no decision to make.
    if (!acted.has(seat.seat)) continue;
    const own = record.preflop.filter(action => action.seat === seat.seat).map(action => action.type);
    sink.add(seat.seat, "vpip", own.some(type => voluntary.includes(type)));
    sink.add(seat.seat, "pfr", own.some(type => raises.includes(type)));
  }
}

function flopEvents(record: HandRecordV1, flopSeats: number[], aggressor: number | null, sink: EventSink) {
  const flop = record.postflop.filter(action => action.street === "flop");
  if (aggressor === null || !flopSeats.includes(aggressor)) return;
  const first = flop.findIndex(action => action.seat === aggressor);
  if (first < 0 || flop.slice(0, first).some(action => action.type === "bet")) return;
  sink.add(aggressor, "flop_cbet", flop[first].type === "bet");
  if (flop[first].type !== "bet") return;
  const responded = new Set<number>();
  for (const action of flop.slice(first + 1)) {
    // Back at the c-bettor means someone raised; after a raise, later players face the raise instead.
    if (action.seat === aggressor) break;
    if (responded.has(action.seat)) continue;
    responded.add(action.seat);
    sink.add(action.seat, "fold_to_flop_cbet", action.type === "fold");
    if (action.type === "raise") break;
  }
}

/** Stat events per seat for a finished, replayed hand. Seats without a player are filtered out by the caller. */
export function computeStatEvents(record: HandRecordV1, end: HandEnd, preflopState: BettingState): Map<number, StatEvent[]> {
  const sink = new EventSink();
  preflopEvents(record, sink);
  const preflopLive = record.seats.map(seat => seat.seat).filter(seat => !preflopState.foldedSeats.has(seat));
  const flopSeats = preflopLive.length > 1 ? preflopLive : [];
  const lastRaise = record.preflop.findLast(action => raises.includes(action.type));
  flopEvents(record, flopSeats, lastRaise?.seat ?? null, sink);
  for (const seat of flopSeats) {
    const own = record.postflop.filter(action => action.seat === seat);
    const count = (types: string[]) => own.filter(action => types.includes(action.type)).length;
    const wentToShowdown = end.showdown && end.liveSeats.includes(seat);
    sink.add(seat, "saw_flop", true);
    sink.add(seat, "wtsd", wentToShowdown);
    if (wentToShowdown) sink.add(seat, "wsd", record.winners.includes(seat));
    for (const [stat, types] of [["af_aggr", ["bet", "raise"]], ["af_call", ["call"]], ["af_fold", ["fold"]]] as const) {
      if (count([...types])) sink.add(seat, stat, count([...types]));
    }
  }
  return sink.bySeat;
}

/** Limped, single-raised, 3-bet or 4-bet+ pot, from the preflop raise count. */
export function potType(preflopState: BettingState) {
  return (["limped", "srp", "3bp"] as const)[preflopState.raiseCount] ?? "4bp";
}
