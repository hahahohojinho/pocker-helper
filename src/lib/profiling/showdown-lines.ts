import type { BettingState } from "../preflop-machine";
import { comboToClass, type HandRecordV1 } from "./hand-record";
import type { HandEnd } from "./hand-replay";
import { potType } from "./stats";

export interface ShowdownHand {
  seat: number;
  playerId: string;
  position: string;
  cards: string;
  handClass: string;
  potType: ReturnType<typeof potType>;
  /** The seat's own actions, e.g. "pf=open|f=b|t=x|r=x" (x check, b bet, c call, r raise, f fold). */
  lineKey: string;
  isPfAggressor: boolean;
  board: string;
  won: boolean;
}

const codes = { check: "x", bet: "b", call: "c", raise: "r", fold: "f" } as const;

export function buildLineKey(record: HandRecordV1, seat: number): string {
  const preflop = record.preflop.filter(action => action.seat === seat && !action.implicit).map(action => action.type).join("-");
  const streets = (["flop", "turn", "river"] as const).map(street =>
    `${street[0]}=${record.postflop.filter(action => action.seat === seat && action.street === street).map(action => codes[action.type]).join("")}`);
  return [`pf=${preflop}`, ...streets].join("|");
}

/** Hands shown down by profiled players, keyed by the line they took, for calibrating their ranges. */
export function extractShowdownHands(record: HandRecordV1, end: HandEnd, preflopState: BettingState): ShowdownHand[] {
  if (!end.showdown) return [];
  const aggressor = record.preflop.findLast(action => ["open", "3bet", "4bet", "5bet"].includes(action.type))?.seat;
  return record.seats.flatMap(seat => {
    const handClass = seat.holeCards ? comboToClass(...seat.holeCards) : null;
    if (!seat.playerId || !seat.holeCards || !handClass || !end.liveSeats.includes(seat.seat)) return [];
    return [{
      seat: seat.seat, playerId: seat.playerId, position: seat.position, cards: seat.holeCards.join(""), handClass,
      potType: potType(preflopState), lineKey: buildLineKey(record, seat.seat), isPfAggressor: aggressor === seat.seat,
      board: record.board.join(""), won: record.winners.includes(seat.seat),
    }];
  });
}
