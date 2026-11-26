import { buildHandRecord, newRecordId } from "../profiling/build-record";
import { comboToClass, type HandRecordV1 } from "../profiling/hand-record";
import { bestHolders, replayHandRecord, type HandEnd } from "../profiling/hand-replay";
import { settleHand } from "../profiling/settle";
import type { RakeSetting } from "../table-config";
import { handTurn, visibleBoard, type SelfPlayHand } from "./hand-state";

export type HandResult =
  | { ok: true; record: HandRecordV1; end: HandEnd; winners: number[]; payouts: number[]; stacks: number[]; rake: number }
  | { ok: false; message: string };

/**
 * Settles a finished self-play hand with the hand recorder's code: the hand becomes a record (every seated slot shows
 * its cards), is replayed through the validators, and pots are split by the shown hands.
 */
export function finishHand(hand: SelfPlayHand, rake: RakeSetting, playedAt = new Date().toISOString()): HandResult {
  const turn = handTurn(hand);
  if (turn.kind !== "over") return { ok: false, message: "핸드가 아직 끝나지 않았습니다." };
  // The record needs one hero; any seated slot will do, since self-play profiles no one.
  const heroSeat = hand.seatPlayer.findIndex(player => player !== null);
  const heroCards = hand.holeCards[heroSeat]!;
  const base = {
    id: newRecordId(), playedAt, tableSize: 6 as const, heroSeat, heroHand: comboToClass(...heroCards) ?? "", stacks: hand.startStacks,
    seatPlayers: hand.seatPlayer.map(() => null), preflop: hand.preflop, postflop: hand.postflop, board: visibleBoard(hand, turn),
    holeCards: Object.fromEntries(hand.holeCards.flatMap((cards, seat) => cards ? [[seat, cards]] : [])),
  };
  const draft = buildHandRecord({ ...base, winners: turn.liveSeats });
  const replay = replayHandRecord(draft, { checkWinners: false });
  if (!replay.ok) return { ok: false, message: replay.message };
  if (!replay.end.finished) return { ok: false, message: replay.end.pending };
  const best = replay.end.showdown ? bestHolders(draft, replay.end.liveSeats) : replay.end.liveSeats;
  // Every seated slot shows its cards, so a showdown always has a best hand.
  if (!best) return { ok: false, message: "쇼다운 승자를 판정할 수 없습니다." };
  const winners = best;
  const record = { ...draft, winners };
  const settlement = settleHand(record, replay.end, replay.preflopState, rake);
  if (!settlement.ok) return { ok: false, message: settlement.message };
  return { ok: true, record, end: replay.end, winners, payouts: settlement.payouts, stacks: settlement.stacks, rake: settlement.rake };
}

/** Below this a player cannot post the big blind and still act, so they rebuy. */
export const MIN_PLAY_STACK = 2;

/**
 * Player stacks for the next hand: each player's settled slot stack; a player who cannot post the big blind
 * (all-in for less than a blind is not modelled) rebuys.
 */
export function carryStacks(hand: SelfPlayHand, settledStacks: readonly number[], rebuy: number, minimum = MIN_PLAY_STACK): number[] {
  const playerCount = hand.seatPlayer.filter(player => player !== null).length;
  const stacks = Array<number>(playerCount).fill(rebuy);
  hand.seatPlayer.forEach((player, slot) => {
    if (player === null) return;
    const settled = settledStacks[slot];
    stacks[player] = Number.isFinite(settled) && settled >= minimum ? settled : rebuy;
  });
  return stacks;
}
