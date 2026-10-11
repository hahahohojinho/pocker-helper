import type { PlayerAction } from "../game-state";
import type { PostflopAction } from "../postflop-machine";
import { normalizeStartingHand } from "../strategy-data";
import { comboToClass, HAND_RECORD_VERSION, ID_PATTERN, TABLE_SLOT_POSITIONS, type HandRecordV1, type ProfileTableSize } from "./hand-record";

const SEAT_PLAYERS_KEY = "rangelab.seat-players.v1";

/** Assembles a record from the table helper's state. Validate it with parseHandRecord and replayHandRecord. */
export function buildHandRecord(input: {
  id: string; playedAt: string; tableSize: ProfileTableSize; heroSeat: number; heroHand: string; stacks: readonly number[];
  seatPlayers: readonly (string | null)[]; preflop: PlayerAction[]; postflop: PostflopAction[]; board: readonly string[];
  holeCards: Readonly<Record<number, readonly string[] | undefined>>; winners: readonly number[];
}): HandRecordV1 {
  const heroHand = normalizeStartingHand(input.heroHand) ?? input.heroHand;
  const seats = TABLE_SLOT_POSITIONS[input.tableSize].map((position, seat) => {
    const cards = input.holeCards[seat]?.filter(Boolean) ?? [];
    const complete = cards.length === 2 ? [cards[0], cards[1]] as [string, string] : null;
    // The hero's cards are kept only when they agree with the hand typed into the table helper.
    const holeCards = complete && (seat !== input.heroSeat || comboToClass(...complete) === heroHand) ? complete : null;
    return { seat, position, playerId: seat === input.heroSeat ? null : input.seatPlayers[seat] ?? null, isHero: seat === input.heroSeat, startStack: input.stacks[seat] ?? 100, holeCards };
  });
  return {
    version: HAND_RECORD_VERSION, id: input.id, playedAt: input.playedAt, tableSize: input.tableSize, heroHand, seats,
    preflop: input.preflop, postflop: input.postflop, board: input.board.filter(Boolean), winners: [...input.winners],
  };
}

/** Next hand: the button moves one seat, so whoever was in slot i+1 (SB for slot 0) now sits in slot i. */
export function rotateForNextHand<T>(slots: readonly T[]): T[] {
  return slots.map((_, index) => slots[(index + 1) % slots.length]);
}
export const rotateHeroSeat = (heroSeat: number, tableSize: number) => (heroSeat - 1 + tableSize) % tableSize;

export type SeatPlayers = Record<ProfileTableSize, (string | null)[]>;
const emptySeats = (): SeatPlayers => ({ 6: Array(6).fill(null), 8: Array(8).fill(null) });

/** Seat assignments saved in the browser; anything malformed is dropped rather than trusted. */
export function parseSeatPlayers(text: string | null): SeatPlayers {
  const result = emptySeats();
  if (!text) return result;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    for (const size of [6, 8] as const) {
      const list = value?.[size];
      if (Array.isArray(list) && list.length === size && list.every(id => id === null || (typeof id === "string" && ID_PATTERN.test(id)))) result[size] = list as (string | null)[];
    }
  } catch {
    // Corrupt storage falls back to empty seats.
  }
  return result;
}

export function loadSeatPlayers(): SeatPlayers {
  try {
    return parseSeatPlayers(window.localStorage.getItem(SEAT_PLAYERS_KEY));
  } catch {
    return emptySeats();
  }
}

export function saveSeatPlayers(value: SeatPlayers) {
  try {
    window.localStorage.setItem(SEAT_PLAYERS_KEY, JSON.stringify(value));
  } catch {
    // Blocked storage: assignments last for this page only.
  }
}
