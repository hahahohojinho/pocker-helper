import type { PlayerAction, PlayerActionType } from "../game-state";
import type { PostflopAction, PostflopActionType } from "../postflop-machine";
import type { Position } from "../preflop";
import { parseCard } from "../equity";
import { normalizeStartingHand } from "../strategy-data";

export type ProfileTableSize = 6 | 8;
export const HAND_RECORD_VERSION = 1;
export const MAX_RECORD_ACTIONS = 200;
const MAX_STACK_BB = 10_000;

/** Seat slot -> position, the same slot order the table helper uses (slot 0 is always the button). */
export const TABLE_SLOT_POSITIONS: Record<ProfileTableSize, readonly Position[]> = {
  6: ["BTN", "SB", "BB", "UTG", "HJ", "CO"],
  8: ["BTN", "SB", "BB", "UTG", "UTG+1", "MP", "HJ", "CO"],
};

export interface RecordSeat {
  seat: number;
  position: Position;
  /** Null for the hero and for seats with no assigned player; those seats are not profiled. */
  playerId: string | null;
  isHero: boolean;
  startStack: number;
  holeCards: [string, string] | null;
}

export interface HandRecordV1 {
  version: 1;
  id: string;
  playedAt: string;
  tableSize: ProfileTableSize;
  heroHand: string;
  seats: RecordSeat[];
  preflop: PlayerAction[];
  postflop: PostflopAction[];
  board: string[];
  /** Seats that won at least part of a pot. */
  winners: number[];
}

const preflopTypes: readonly PlayerActionType[] = ["fold", "check", "limp", "open", "call", "3bet", "4bet", "5bet"];
const postflopTypes: readonly PostflopActionType[] = ["fold", "check", "bet", "call", "raise"];
const postflopStreets = ["flop", "turn", "river"] as const;
export const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const fail = (field: string, detail = "is invalid") => new Error(`Hand record ${field} ${detail}.`);
const finiteIn = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

/** "As","Qh" -> "AQo"; null when either card is invalid or both are the same card. */
export function comboToClass(first: string, second: string): string | null {
  const a = parseCard(first), b = parseCard(second);
  if (!a || !b || a.code === b.code) return null;
  return normalizeStartingHand(`${a.code[0]}${b.code[0]}${a.rank === b.rank ? "" : a.suit === b.suit ? "s" : "o"}`);
}

function parseCards(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > max) throw fail(field);
  return value.map(card => {
    const parsed = typeof card === "string" ? parseCard(card) : null;
    if (!parsed) throw fail(field, "has an invalid card");
    return parsed.code;
  });
}

function parseSeat(value: unknown, index: number, tableSize: ProfileTableSize): RecordSeat {
  if (!isRecord(value)) throw fail(`seats[${index}]`);
  if (value.seat !== index || value.position !== TABLE_SLOT_POSITIONS[tableSize][index]) throw fail(`seats[${index}]`, "does not match the table slot");
  if (value.playerId !== null && (typeof value.playerId !== "string" || !ID_PATTERN.test(value.playerId))) throw fail(`seats[${index}].playerId`);
  if (typeof value.isHero !== "boolean") throw fail(`seats[${index}].isHero`);
  if (!finiteIn(value.startStack, 0.5, MAX_STACK_BB)) throw fail(`seats[${index}].startStack`);
  const holeCards = value.holeCards === null ? null : parseCards(value.holeCards, `seats[${index}].holeCards`, 2);
  if (holeCards && holeCards.length !== 2) throw fail(`seats[${index}].holeCards`);
  return { seat: index, position: value.position as Position, playerId: value.playerId as string | null, isHero: value.isHero, startStack: value.startStack, holeCards: holeCards as [string, string] | null };
}

function parseActionBase(value: unknown, field: string, seats: RecordSeat[]) {
  if (!isRecord(value)) throw fail(field);
  if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > 64) throw fail(`${field}.id`);
  if (!Number.isInteger(value.seat) || (value.seat as number) < 0 || (value.seat as number) >= seats.length) throw fail(`${field}.seat`);
  const seat = value.seat as number;
  if (value.position !== seats[seat].position) throw fail(`${field}.position`);
  if (!finiteIn(value.amount, 0, MAX_STACK_BB)) throw fail(`${field}.amount`);
  return { id: value.id, seat, position: seats[seat].position, amount: value.amount, raw: value };
}

function parsePreflopAction(value: unknown, index: number, seats: RecordSeat[]): PlayerAction {
  const base = parseActionBase(value, `preflop[${index}]`, seats);
  if (base.raw.street !== "preflop" || !preflopTypes.includes(base.raw.type as PlayerActionType)) throw fail(`preflop[${index}]`);
  if (base.raw.implicit !== undefined && typeof base.raw.implicit !== "boolean") throw fail(`preflop[${index}].implicit`);
  return { id: base.id, street: "preflop", seat: base.seat, position: base.position, type: base.raw.type as PlayerActionType, amount: base.amount, ...(base.raw.implicit === true ? { implicit: true } : {}) };
}

function parsePostflopAction(value: unknown, index: number, seats: RecordSeat[]): PostflopAction {
  const base = parseActionBase(value, `postflop[${index}]`, seats);
  const street = base.raw.street as PostflopAction["street"];
  if (!postflopStreets.includes(street) || !postflopTypes.includes(base.raw.type as PostflopActionType)) throw fail(`postflop[${index}]`);
  return { id: base.id, street, seat: base.seat, position: base.position, type: base.raw.type as PostflopActionType, amount: base.amount };
}

/**
 * Validates the shape of a client-supplied hand record. Whether the actions are legal and the hand is finished is
 * checked separately by replayHandRecord.
 */
export function parseHandRecord(value: unknown): HandRecordV1 {
  if (!isRecord(value)) throw fail("", "must be an object");
  if (value.version !== HAND_RECORD_VERSION) throw fail("version");
  if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) throw fail("id");
  if (typeof value.playedAt !== "string" || value.playedAt.length > 40 || Number.isNaN(Date.parse(value.playedAt))) throw fail("playedAt");
  if (value.tableSize !== 6 && value.tableSize !== 8) throw fail("tableSize");
  const tableSize = value.tableSize;
  const heroHand = typeof value.heroHand === "string" ? normalizeStartingHand(value.heroHand) : null;
  if (!heroHand || heroHand !== value.heroHand) throw fail("heroHand");
  if (!Array.isArray(value.seats) || value.seats.length !== tableSize) throw fail("seats", `must list all ${tableSize} seats`);
  const seats = value.seats.map((seat, index) => parseSeat(seat, index, tableSize));
  if (seats.filter(seat => seat.isHero).length !== 1) throw fail("seats", "must have exactly one hero");
  if (seats.some(seat => seat.isHero && seat.playerId !== null)) throw fail("seats", "must not profile the hero");
  const playerIds = seats.flatMap(seat => seat.playerId ? [seat.playerId] : []);
  if (new Set(playerIds).size !== playerIds.length) throw fail("seats", "assign one player to two seats");
  if (!Array.isArray(value.preflop) || !Array.isArray(value.postflop) || value.preflop.length + value.postflop.length > MAX_RECORD_ACTIONS) throw fail("actions", `must be arrays of at most ${MAX_RECORD_ACTIONS} in total`);
  const preflop = value.preflop.map((action, index) => parsePreflopAction(action, index, seats));
  const postflop = value.postflop.map((action, index) => parsePostflopAction(action, index, seats));
  const board = parseCards(value.board, "board", 5);
  const dealt = [...board, ...seats.flatMap(seat => seat.holeCards ?? [])];
  if (new Set(dealt).size !== dealt.length) throw fail("cards", "repeat a card");
  const hero = seats.find(seat => seat.isHero)!;
  if (hero.holeCards && comboToClass(...hero.holeCards) !== heroHand) throw fail("heroHand", "does not match the hero's cards");
  if (!Array.isArray(value.winners) || value.winners.length === 0 || value.winners.some(seat => !Number.isInteger(seat) || seat < 0 || seat >= tableSize)) throw fail("winners");
  const winners = [...new Set(value.winners as number[])].sort((left, right) => left - right);
  // Stored in one canonical form so time ordering in the database is lexical ordering.
  return { version: 1, id: value.id, playedAt: new Date(value.playedAt).toISOString(), tableSize, heroHand, seats, preflop, postflop, board, winners };
}
