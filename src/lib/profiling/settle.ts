import type { BettingState } from "../preflop-machine";
import { calculatePokerPots } from "../pots";
import type { HandRecordV1 } from "./hand-record";
import { bestHolders, totalContributions, type HandEnd } from "./hand-replay";

export type Settlement = { ok: true; stacks: number[]; payouts: number[] } | { ok: false; message: string };

/** Amounts are BB with cent precision, the precision of the stack inputs. */
const toCents = (bb: number) => Math.round(bb * 100);

/**
 * Who wins one pot layer: the best shown hand among its eligible seats when every one of them showed, otherwise the
 * chosen winners who are eligible for it. Null when neither decides the layer.
 */
function layerWinners(record: HandRecordV1, eligible: number[], chosen: readonly number[]): number[] | null {
  if (eligible.length === 1) return eligible;
  if (record.board.length === 5) {
    const best = bestHolders(record, eligible);
    if (best) return best;
  }
  const picked = eligible.filter(seat => chosen.includes(seat));
  return picked.length ? picked : null;
}

/**
 * Final stacks after a finished hand: main and side pots from each seat's total contribution, each split between its
 * winners (odd cents to the first winner left of the button), uncalled chips returned. Chips are conserved.
 */
export function settleHand(record: HandRecordV1, end: HandEnd, preflopState: BettingState): Settlement {
  if (!end.finished) return { ok: false, message: "핸드가 아직 끝나지 않았습니다." };
  const starts = record.seats.map(seat => toCents(seat.startStack));
  // A blind posted from a stack shorter than the blind only puts in what the stack holds.
  const totals = totalContributions(record, preflopState).map(toCents).map((total, seat) => Math.min(total, starts[seat]));
  const contributions = new Map(totals.map((amount, seat) => [seat, amount] as const));
  const folded = new Set(record.seats.map(seat => seat.seat).filter(seat => !end.liveSeats.includes(seat)));
  const allIn = new Set(record.seats.map(seat => seat.seat).filter(seat => totals[seat] > 0 && totals[seat] >= starts[seat]));
  const payouts = record.seats.map(() => 0);
  for (const pot of calculatePokerPots(contributions, folded, allIn)) {
    const winners = layerWinners(record, pot.eligibleSeats, record.winners);
    if (!winners) return { ok: false, message: "사이드팟 승자를 정할 수 없습니다. 공개 카드를 입력하거나 승자를 선택하세요." };
    const share = Math.floor(pot.amount / winners.length);
    // Slot 0 is the button: odd cents go clockwise from the seat after it.
    const seatCount = record.seats.length;
    const ordered = [...winners].sort((left, right) => (left - 1 + seatCount) % seatCount - (right - 1 + seatCount) % seatCount);
    ordered.forEach((seat, index) => { payouts[seat] += share + (index === 0 ? pot.amount - share * winners.length : 0); });
  }
  const stacks = starts.map((start, seat) => (start - totals[seat] + payouts[seat]) / 100);
  return { ok: true, stacks, payouts: payouts.map(cents => cents / 100) };
}
