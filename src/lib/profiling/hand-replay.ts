import type { Street } from "../game-state";
import { bestHandScore, parseCard, type Card } from "../equity";
import { deriveBettingState, nextPosition, validatePreflopAction, type BettingState } from "../preflop-machine";
import { postflopOrder } from "../postflop-machine";
import { buildPostflopContext, nextPostflopActor, validatePostflopActionV2, type PostflopContext } from "../postflop-hand-state";
import type { HandRecordV1 } from "./hand-record";

const streets = ["flop", "turn", "river"] as const;
type PostflopStreet = typeof streets[number];

export interface HandEnd {
  finished: boolean;
  /** Why the hand is not finished yet; empty when finished. */
  pending: string;
  endStreet: Street;
  showdown: boolean;
  /** Seats still in the hand at the end. */
  liveSeats: number[];
}

export type ReplayResult = { ok: true; end: HandEnd; preflopState: BettingState } | { ok: false; message: string };

const invalid = (message: string): ReplayResult => ({ ok: false, message });

/** The postflop view the table helper builds after preflop, reproduced from the record. */
function postflopSetup(record: HandRecordV1, preflopState: BettingState) {
  const positions = record.seats.map(seat => seat.position);
  const activeSeats = positions.map((_, seat) => seat).filter(seat => !preflopState.foldedSeats.has(seat));
  const order = postflopOrder(positions, new Set([...preflopState.foldedSeats, ...preflopState.allInSeats]));
  const initialRemaining = record.seats.map(seat => Math.max(0, seat.startStack - (preflopState.contributions.get(seat.seat) ?? 0)));
  const contextAt = (actions: HandRecordV1["postflop"], street: PostflopStreet) =>
    buildPostflopContext({ actions, street, seats: activeSeats, initialRemaining, initialPot: preflopState.pot });
  return { activeSeats, order, contextAt };
}

function replayPreflop(record: HandRecordV1): string | null {
  const positions = record.seats.map(seat => seat.position);
  const stacks = record.seats.map(seat => seat.startStack);
  for (const [index, action] of record.preflop.entries()) {
    const prior = record.preflop.slice(0, index);
    if (nextPosition(prior, positions, stacks) !== action.position) return `preflop[${index}] is out of turn`;
    const result = validatePreflopAction({ actions: prior, positions, seat: action.seat, type: action.type, amount: action.amount, effectiveStack: stacks[action.seat], stacks });
    if (!result.valid) return `preflop[${index}]: ${result.message}`;
  }
  return null;
}

function replayPostflop(record: HandRecordV1, setup: ReturnType<typeof postflopSetup>): { error: string } | { street: number } {
  let street = 0;
  for (const [index, action] of record.postflop.entries()) {
    const target = streets.indexOf(action.street);
    if (target < street) return { error: `postflop[${index}] goes back to an earlier street` };
    const prior = record.postflop.slice(0, index);
    for (; street < target; street++) {
      if (nextPostflopActor(setup.contextAt(prior, streets[street]), setup.order) !== null) return { error: `postflop[${index}] starts ${action.street} before ${streets[street]} is finished` };
    }
    if (record.board.length < 3 + street) return { error: `postflop[${index}] is on ${action.street} without its board cards` };
    const context = setup.contextAt(prior, streets[street]);
    if (nextPostflopActor(context, setup.order) !== action.seat) return { error: `postflop[${index}] is out of turn` };
    const result = validatePostflopActionV2(context, action.seat, action.type, action.amount);
    if (!result.valid) return { error: `postflop[${index}]: ${result.message}` };
  }
  return { street };
}

/** No one can bet any more (at most one player with chips and no one owing): the board just runs out. */
function isRunout(context: PostflopContext, liveSeats: number[]) {
  const actionable = liveSeats.filter(seat => !context.allInSeats.has(seat));
  return actionable.length <= 1 && liveSeats.every(seat => context.allInSeats.has(seat) || (context.contributions.get(seat) ?? 0) === context.currentBet);
}

function bestHolders(record: HandRecordV1, liveSeats: number[]): number[] | null {
  const board = record.board.map(parseCard) as Card[];
  const scores = liveSeats.map(seat => {
    const hole = record.seats[seat].holeCards;
    return hole ? bestHandScore([...board, ...hole.map(card => parseCard(card) as Card)]) : null;
  });
  if (scores.some(score => score === null)) return null;
  const best = Math.max(...(scores as number[]));
  return liveSeats.filter((_, index) => scores[index] === best);
}

function checkWinners(record: HandRecordV1, end: HandEnd): string | null {
  if (!end.finished) return null;
  if (record.winners.some(seat => !end.liveSeats.includes(seat))) return "winners include a seat that folded";
  if (!end.showdown) return record.winners.length === 1 && record.winners[0] === end.liveSeats[0] ? null : "winners must be the last player left";
  // The best hand always wins at least part of the main pot, which every live player is in.
  const best = bestHolders(record, end.liveSeats);
  return best && !best.some(seat => record.winners.includes(seat)) ? "winners leave out the best shown hand" : null;
}

/**
 * Replays a parsed record through the same validators as the table helper, so only legal action sequences are
 * stored, and reports whether and how the hand ended.
 */
export function replayHandRecord(record: HandRecordV1): ReplayResult {
  const preflopError = replayPreflop(record);
  if (preflopError) return invalid(preflopError);
  const positions = record.seats.map(seat => seat.position);
  const stacks = record.seats.map(seat => seat.startStack);
  const preflopState = deriveBettingState(record.preflop, positions, stacks);
  const preflopLive = positions.map((_, seat) => seat).filter(seat => !preflopState.foldedSeats.has(seat));
  const preflopOpen = nextPosition(record.preflop, positions, stacks) !== null;
  if ((preflopOpen || preflopLive.length <= 1) && record.postflop.length) return invalid("postflop actions follow a hand that did not reach the flop");
  if (preflopOpen) return { ok: true, preflopState, end: { finished: false, pending: "preflop is not finished", endStreet: "preflop", showdown: false, liveSeats: preflopLive } };
  let end: HandEnd;
  if (preflopLive.length <= 1) {
    end = { finished: true, pending: "", endStreet: "preflop", showdown: false, liveSeats: preflopLive };
  } else {
    const setup = postflopSetup(record, preflopState);
    const replay = replayPostflop(record, setup);
    if ("error" in replay) return invalid(replay.error);
    const street = streets[replay.street];
    const context = setup.contextAt(record.postflop, street);
    const liveSeats = setup.activeSeats.filter(seat => !context.foldedSeats.has(seat));
    const showdown = liveSeats.length > 1 && (isRunout(context, liveSeats) || (street === "river" && nextPostflopActor(context, setup.order) === null));
    const pending = liveSeats.length <= 1 ? "" : !showdown ? "the hand has not reached showdown" : record.board.length < 5 ? "the board needs five cards for showdown" : "";
    end = { finished: pending === "", pending, endStreet: street, showdown, liveSeats };
  }
  const winnerError = checkWinners(record, end);
  return winnerError ? invalid(winnerError) : { ok: true, end, preflopState };
}
