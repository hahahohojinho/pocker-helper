import type { PlayerActionType } from "../../game-state";
import type { PostflopActionType } from "../../postflop-machine";
import { TABLE_SLOT_POSITIONS, type HandRecordV1, type ProfileTableSize } from "../hand-record";

export const PLAYER = {
  a: "00000000-0000-4000-8000-00000000000a",
  b: "00000000-0000-4000-8000-00000000000b",
  c: "00000000-0000-4000-8000-00000000000c",
  d: "00000000-0000-4000-8000-00000000000d",
  e: "00000000-0000-4000-8000-00000000000e",
} as const;

type Pre = [number, PlayerActionType, number?];
type Post = [HandRecordV1["postflop"][number]["street"], number, PostflopActionType, number?];

/**
 * Builds a 6-max (or 8-max) record. Slots: 0 BTN, 1 SB, 2 BB, 3 UTG, 4 HJ, 5 CO (6-max). The hero sits in slot 2
 * unless `heroSeat` says otherwise; every other slot gets a player from PLAYER in order.
 */
export function makeHand(input: {
  id?: string; tableSize?: ProfileTableSize; heroSeat?: number; stack?: number; heroHand?: string;
  preflop: Pre[]; postflop?: Post[]; board?: string[]; winners: number[]; holeCards?: Record<number, [string, string]>;
  players?: (string | null)[];
}): HandRecordV1 {
  const tableSize = input.tableSize ?? 6;
  const positions = TABLE_SLOT_POSITIONS[tableSize];
  const heroSeat = input.heroSeat ?? 2;
  const ids = Object.values(PLAYER);
  let next = 0;
  const seats = positions.map((position, seat) => ({
    seat, position, isHero: seat === heroSeat, startStack: input.stack ?? 100,
    playerId: seat === heroSeat ? null : input.players ? input.players[seat] ?? null : ids[next++] ?? null,
    holeCards: input.holeCards?.[seat] ?? null,
  }));
  return {
    version: 1, id: input.id ?? "11111111-1111-4111-8111-111111111111", playedAt: "2026-10-11T00:00:00.000Z", tableSize,
    heroHand: input.heroHand ?? "72o", seats,
    preflop: input.preflop.map(([seat, type, amount], index) => ({ id: `p${index}`, street: "preflop", seat, position: positions[seat], type, amount: amount ?? 0 })),
    postflop: (input.postflop ?? []).map(([street, seat, type, amount], index) => ({ id: `q${index}`, street, seat, position: positions[seat], type, amount: amount ?? 0 })),
    board: input.board ?? [], winners: input.winners,
  };
}

/** UTG and HJ fold, CO opens 2.5, BTN calls, blinds fold; CO c-bets 3, BTN calls, then checks to showdown. */
export function srpToShowdown(winners = [0]) {
  return makeHand({
    preflop: [[3, "fold"], [4, "fold"], [5, "open", 2.5], [0, "call", 2.5], [1, "fold"], [2, "fold"]],
    postflop: [["flop", 5, "bet", 3], ["flop", 0, "call", 3], ["turn", 5, "check"], ["turn", 0, "check"], ["river", 5, "check"], ["river", 0, "check"]],
    board: ["2c", "7d", "9h", "Ts", "3c"], winners,
    holeCards: { 5: ["Ah", "Kh"], 0: ["Qs", "Qd"] },
  });
}
