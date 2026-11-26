import type { BettingState } from "../preflop-machine";
import { calculatePokerPots } from "../pots";
import type { HandRecordV1 } from "./hand-record";
import { bestHolders, recordAntes, totalContributions, type HandEnd } from "./hand-replay";
import { hasRake, NO_RAKE, type RakeSetting } from "../table-config";

export type Settlement = { ok: true; stacks: number[]; payouts: number[]; rake: number } | { ok: false; message: string };

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
 * winners (odd cents to the first winner left of the button), uncalled chips returned. Rake (capped, only when the
 * hand saw a flop) leaves the table; every other chip is conserved.
 */
export function settleHand(record: HandRecordV1, end: HandEnd, preflopState: BettingState, rakeSetting: RakeSetting = NO_RAKE): Settlement {
  if (!end.finished) return { ok: false, message: "핸드가 아직 끝나지 않았습니다." };
  const starts = record.seats.map(seat => toCents(seat.startStack));
  // Antes are dead money: they leave every stack up front and join the main pot, outside the betting layers.
  const antes = recordAntes(record);
  const posted = antes.posted.map(toCents);
  const playable = starts.map((start, seat) => start - posted[seat]);
  const deadCents = posted.reduce((sum, amount) => sum + amount, 0);
  // A blind posted from a stack shorter than the blind only puts in what the stack holds.
  const committed = totalContributions(record, preflopState).map(toCents).map((total, seat) => Math.min(total, playable[seat]));
  // Chips above the second-largest contribution were never called: they go straight back and are not raked.
  const ranked = [...committed].sort((left, right) => right - left);
  const topSeat = committed.indexOf(ranked[0]);
  const uncalled = Math.max(0, ranked[0] - (ranked[1] ?? 0));
  const totals = committed.map((total, seat) => seat === topSeat ? total - uncalled : total);
  const contributions = new Map(totals.map((amount, seat) => [seat, amount] as const));
  const folded = new Set(record.seats.map(seat => seat.seat).filter(seat => !end.liveSeats.includes(seat)));
  const allIn = new Set(record.seats.map(seat => seat.seat).filter(seat => committed[seat] > 0 && committed[seat] >= playable[seat]));
  const payouts = record.seats.map((_, seat) => seat === topSeat ? uncalled : 0);
  // Every live seat is eligible for the main pot, so the antes go there.
  const pots = calculatePokerPots(contributions, folded, allIn).map((pot, index) => index === 0 ? { ...pot, amount: pot.amount + deadCents } : pot);
  // No flop, no drop.
  const contestedCents = pots.reduce((sum, pot) => sum + pot.amount, 0);
  let rake = end.endStreet !== "preflop" && hasRake(rakeSetting) ? Math.min(Math.round(contestedCents * rakeSetting.percent / 100), toCents(rakeSetting.capBb)) : 0;
  const totalRake = rake;
  for (const pot of pots) {
    // Rake comes out of the main pot first, then later layers.
    const taken = Math.min(rake, pot.amount);
    rake -= taken;
    const amount = pot.amount - taken;
    const winners = layerWinners(record, pot.eligibleSeats, record.winners);
    if (!winners) return { ok: false, message: "사이드팟 승자를 정할 수 없습니다. 공개 카드를 입력하거나 승자를 선택하세요." };
    const share = Math.floor(amount / winners.length);
    // Slot 0 is the button: odd cents go clockwise from the seat after it.
    const seatCount = record.seats.length;
    const ordered = [...winners].sort((left, right) => (left - 1 + seatCount) % seatCount - (right - 1 + seatCount) % seatCount);
    ordered.forEach((seat, index) => { payouts[seat] += share + (index === 0 ? amount - share * winners.length : 0); });
  }
  const stacks = playable.map((play, seat) => (play - committed[seat] + payouts[seat]) / 100);
  return { ok: true, stacks, payouts: payouts.map(cents => cents / 100), rake: totalRake / 100 };
}
