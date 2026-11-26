import type { PlayerAction, PlayerActionType } from "../game-state";
import type { Position } from "../preflop";
import { availableActions, bettingAmounts, deriveBettingState, nextPosition, positionOrder, validatePreflopAction, type BettingState } from "../preflop-machine";
import { postflopOrder, type PostflopAction, type PostflopActionType } from "../postflop-machine";
import { availablePostflopActions, buildPostflopContext, nextPostflopActor, validatePostflopActionV2, type PostflopContext } from "../postflop-hand-state";
import { TABLE_SLOT_POSITIONS } from "../profiling/hand-record";
import { dealHand } from "./deck";

/** Self-play uses the 6-max slots (slot 0 = BTN); fewer players leave the early slots empty. */
export const SLOT_POSITIONS: Position[] = [...TABLE_SLOT_POSITIONS[6]];
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
/** Empty slots never act; they still need a legal record stack. */
const EMPTY_SLOT_STACK = 100;

/** Occupied slots in clockwise order from the button. 2 players: SB vs BB; 3: +BTN; 4: +CO; 5: +HJ; 6: all. */
export function occupiedSlots(playerCount: number): number[] {
  if (!Number.isInteger(playerCount) || playerCount < MIN_PLAYERS || playerCount > MAX_PLAYERS) throw new Error(`Player count must be ${MIN_PLAYERS}-${MAX_PLAYERS}.`);
  const fromButton = [0, 1, 2, 3, 4, 5];
  // Empty slots are the earliest preflop positions (UTG, HJ, CO, BTN), so they all act before anyone seated.
  const emptied = ["UTG", "HJ", "CO", "BTN"].slice(0, MAX_PLAYERS - playerCount).map(position => SLOT_POSITIONS.indexOf(position as Position));
  return fromButton.filter(slot => !emptied.includes(slot));
}

export type PostflopStreet = "flop" | "turn" | "river";
const POSTFLOP_STREETS: PostflopStreet[] = ["flop", "turn", "river"];
export const BOARD_COUNT: Record<PostflopStreet, number> = { flop: 3, turn: 4, river: 5 };

export interface SelfPlayHand {
  seed: number;
  handNo: number;
  /** Slot -> player index; null for an empty slot. */
  seatPlayer: (number | null)[];
  startStacks: number[];
  holeCards: ([string, string] | null)[];
  /** All five board cards; only the street's share is shown. */
  board: string[];
  preflop: PlayerAction[];
  postflop: PostflopAction[];
}

/** The button moves one player per hand: occupied slot k holds player (k + handNo) mod n. */
export function createHand(input: { seed: number; handNo: number; stacks: readonly number[] }): SelfPlayHand {
  const playerCount = input.stacks.length;
  const occupied = occupiedSlots(playerCount);
  const seatPlayer = SLOT_POSITIONS.map((_, slot) => {
    const ring = occupied.indexOf(slot);
    return ring < 0 ? null : (ring + input.handNo) % playerCount;
  });
  const startStacks = seatPlayer.map(player => player === null ? EMPTY_SLOT_STACK : input.stacks[player]);
  const deal = dealHand(input.seed, seatPlayer.map(player => player !== null));
  const order = positionOrder(SLOT_POSITIONS);
  // Empty slots fold first, in preflop order, so the engine starts at the first seated player.
  const preflop: PlayerAction[] = order.map(position => SLOT_POSITIONS.indexOf(position)).filter(slot => seatPlayer[slot] === null)
    .map((slot, index) => ({ id: `empty-${index}`, street: "preflop", seat: slot, position: SLOT_POSITIONS[slot], type: "fold", amount: 0, implicit: true }));
  return { seed: input.seed, handNo: input.handNo, seatPlayer, startStacks, holeCards: deal.holeCards, board: deal.board, preflop, postflop: [] };
}

export type HandTurn =
  | { kind: "preflop"; seat: number; position: Position; allowed: PlayerActionType[]; amounts: ReturnType<typeof bettingAmounts> }
  | { kind: "postflop"; street: PostflopStreet; seat: number; position: Position; allowed: PostflopActionType[]; context: PostflopContext }
  | { kind: "over"; street: "preflop" | PostflopStreet; showdown: boolean; liveSeats: number[] };

export const preflopState = (hand: SelfPlayHand): BettingState => deriveBettingState(hand.preflop, SLOT_POSITIONS, hand.startStacks);

/** Everything the postflop engine needs; the same derivation as the hand replay. */
export function postflopSetup(hand: SelfPlayHand) {
  const state = preflopState(hand);
  const activeSeats = SLOT_POSITIONS.map((_, seat) => seat).filter(seat => !state.foldedSeats.has(seat));
  const order = postflopOrder(SLOT_POSITIONS, new Set([...state.foldedSeats, ...state.allInSeats]));
  const initialRemaining = hand.startStacks.map((stack, seat) => Math.max(0, stack - (state.contributions.get(seat) ?? 0)));
  const contextAt = (street: PostflopStreet, actions: PostflopAction[] = hand.postflop) =>
    buildPostflopContext({ actions, street, seats: activeSeats, initialRemaining, initialPot: state.pot });
  return { state, activeSeats, order, initialRemaining, contextAt };
}

/** No one can bet any more: at most one seat with chips and no one owing. */
function isRunout(context: PostflopContext, liveSeats: number[]) {
  const actionable = liveSeats.filter(seat => !context.allInSeats.has(seat));
  return actionable.length <= 1 && liveSeats.every(seat => context.allInSeats.has(seat) || (context.contributions.get(seat) ?? 0) === context.currentBet);
}

/** Whose turn it is, or how the hand ended. */
export function handTurn(hand: SelfPlayHand): HandTurn {
  const state = preflopState(hand);
  const position = nextPosition(hand.preflop, SLOT_POSITIONS, hand.startStacks);
  if (position) {
    const seat = SLOT_POSITIONS.indexOf(position);
    return { kind: "preflop", seat, position, allowed: availableActions(hand.preflop, SLOT_POSITIONS, seat, hand.startStacks), amounts: bettingAmounts(hand.preflop, SLOT_POSITIONS, seat, hand.startStacks) };
  }
  const preflopLive = SLOT_POSITIONS.map((_, seat) => seat).filter(seat => !state.foldedSeats.has(seat));
  if (preflopLive.length <= 1) return { kind: "over", street: "preflop", showdown: false, liveSeats: preflopLive };
  const setup = postflopSetup(hand);
  for (const street of POSTFLOP_STREETS) {
    const context = setup.contextAt(street);
    const liveSeats = setup.activeSeats.filter(seat => !context.foldedSeats.has(seat));
    if (liveSeats.length <= 1) return { kind: "over", street, showdown: false, liveSeats };
    if (isRunout(context, liveSeats)) return { kind: "over", street, showdown: true, liveSeats };
    const seat = nextPostflopActor(context, setup.order);
    if (seat !== null) return { kind: "postflop", street, seat, position: SLOT_POSITIONS[seat], allowed: availablePostflopActions(context, seat), context };
    if (street === "river") return { kind: "over", street, showdown: true, liveSeats };
  }
  throw new Error("unreachable: the river always ends the hand");
}

/** Chips each slot has put in so far: preflop plus the latest amount on each postflop street. */
export function committedBySeat(hand: SelfPlayHand): number[] {
  const state = preflopState(hand);
  const totals = SLOT_POSITIONS.map((_, seat) => state.contributions.get(seat) ?? 0);
  for (const street of POSTFLOP_STREETS) {
    const latest = new Map<number, number>();
    for (const action of hand.postflop) if (action.street === street && action.type !== "fold" && action.type !== "check") latest.set(action.seat, action.amount);
    for (const [seat, amount] of latest) totals[seat] += amount;
  }
  return totals.map(total => Math.round(total * 100) / 100);
}

/** Board cards visible now: none preflop, the street's share during play, all five at a showdown. */
export function visibleBoard(hand: SelfPlayHand, turn: HandTurn = handTurn(hand)): string[] {
  if (turn.kind === "preflop") return [];
  if (turn.kind === "postflop") return hand.board.slice(0, BOARD_COUNT[turn.street]);
  if (turn.showdown) return [...hand.board];
  return turn.street === "preflop" ? [] : hand.board.slice(0, BOARD_COUNT[turn.street]);
}

export type ApplyResult = { ok: true; hand: SelfPlayHand } | { ok: false; message: string };

const NEEDS_AMOUNT: readonly PlayerActionType[] = ["limp", "open", "call", "3bet", "4bet", "5bet"];

/** Adds the current seat's action after the same validation the table helper uses. Returns a new hand. */
export function applyAction(hand: SelfPlayHand, type: PlayerActionType | PostflopActionType, amount: number): ApplyResult {
  const turn = handTurn(hand);
  if (turn.kind === "over") return { ok: false, message: "핸드가 끝났습니다." };
  if (turn.kind === "preflop") {
    const preflopType = type as PlayerActionType;
    const check = validatePreflopAction({ actions: hand.preflop, positions: SLOT_POSITIONS, seat: turn.seat, type: preflopType, amount, effectiveStack: hand.startStacks[turn.seat], stacks: hand.startStacks });
    if (!check.valid) return { ok: false, message: check.message };
    const action: PlayerAction = { id: `p${hand.preflop.length}`, street: "preflop", seat: turn.seat, position: turn.position, type: preflopType, amount: NEEDS_AMOUNT.includes(preflopType) ? amount : 0 };
    return { ok: true, hand: { ...hand, preflop: [...hand.preflop, action] } };
  }
  const postflopType = type as PostflopActionType;
  const check = validatePostflopActionV2(turn.context, turn.seat, postflopType, amount);
  if (!check.valid) return { ok: false, message: check.message };
  const action: PostflopAction = { id: `${turn.street}${hand.postflop.length}`, street: turn.street, seat: turn.seat, position: turn.position, type: postflopType, amount: postflopType === "fold" || postflopType === "check" ? 0 : amount };
  return { ok: true, hand: { ...hand, postflop: [...hand.postflop, action] } };
}

/** Removes the last real action (empty-slot folds stay). */
export function undoAction(hand: SelfPlayHand): SelfPlayHand {
  if (hand.postflop.length) return { ...hand, postflop: hand.postflop.slice(0, -1) };
  const last = hand.preflop.at(-1);
  return last && !last.implicit ? { ...hand, preflop: hand.preflop.slice(0, -1) } : hand;
}

export const canUndo = (hand: SelfPlayHand) => hand.postflop.length > 0 || hand.preflop.some(action => !action.implicit);
