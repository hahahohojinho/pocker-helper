import { describe, expect, it } from "vitest";
import { replayHandRecord } from "./hand-replay";
import { settleHand } from "./settle";
import { makeHand, srpToShowdown } from "./__fixtures__/hands";
import type { HandRecordV1 } from "./hand-record";

function settle(record: HandRecordV1) {
  const replay = replayHandRecord(record, { checkWinners: false });
  if (!replay.ok) throw new Error(replay.message);
  return settleHand(record, replay.end, replay.preflopState);
}
const sum = (values: number[]) => Math.round(values.reduce((total, value) => total + value, 0) * 100) / 100;

describe("settleHand", () => {
  it("pays a showdown pot to the best hand and conserves chips", () => {
    // Pot 12.5: CO and BTN 5.5 each, blinds 0.5 and 1; BTN's queens beat CO's ace-king.
    const result = settle(srpToShowdown());
    expect(result).toEqual({ ok: true, stacks: [107, 99.5, 99, 100, 100, 94.5], payouts: [12.5, 0, 0, 0, 0, 0], rake: 0 });
    if (result.ok) expect(sum(result.stacks)).toBe(600);
  });
  it("gives the blinds to the last player left and returns nothing uncalled beyond the open", () => {
    const result = settle(makeHand({ preflop: [[3, "fold"], [4, "fold"], [5, "open", 2.5], [0, "fold"], [1, "fold"], [2, "fold"]], winners: [5] }));
    expect(result).toMatchObject({ ok: true, stacks: [100, 99.5, 99, 100, 100, 101.5] });
  });
  it("splits a side pot to its own winner and returns an uncalled all-in excess", () => {
    // Seat 3 has 20bb, seat 5 has 100bb, seat 0 has 50bb: all in preflop. Board gives seat 3 the best hand,
    // seat 0 the second best: main pot to seat 3, side pot (0 vs 5) to seat 0, seat 5's uncalled 50 returned.
    const record = makeHand({
      preflop: [[3, "open", 20], [4, "fold"], [5, "3bet", 100], [0, "call", 50], [1, "fold"], [2, "fold"]],
      board: ["2c", "7d", "9h", "Ts", "3c"], winners: [3],
      holeCards: { 3: ["As", "Ad"], 0: ["Ks", "Kd"], 5: ["Qs", "Qd"] },
    });
    const stacks = record.seats.map(seat => seat.seat === 3 ? { ...seat, startStack: 20 } : seat.seat === 0 ? { ...seat, startStack: 50 } : seat);
    const result = settle({ ...record, seats: stacks });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Main 20x3 + blinds 1.5 = 61.5 to seat 3; side 30x2 = 60 to seat 0; seat 5 keeps 100 - 50.
    expect(result.stacks[3]).toBe(61.5);
    expect(result.stacks[0]).toBe(60);
    expect(result.stacks[5]).toBe(50);
    expect(sum(result.stacks)).toBe(20 + 50 + 100 + 100 + 100 + 100);
  });
  it("refuses to settle a side pot nobody decides", () => {
    const record = makeHand({
      preflop: [[3, "open", 20], [4, "fold"], [5, "3bet", 100], [0, "call", 50], [1, "fold"], [2, "fold"]],
      board: ["2c", "7d", "9h", "Ts", "3c"], winners: [3],
    });
    const seats = record.seats.map(seat => seat.seat === 3 ? { ...seat, startStack: 20 } : seat.seat === 0 ? { ...seat, startStack: 50 } : seat);
    expect(settle({ ...record, seats })).toMatchObject({ ok: false });
  });
  it("gives an odd cent to the first winner left of the button", () => {
    // The SB posts only 0.49 from a 0.49bb stack, so BTN (slot 0) and CO (slot 5) split 12.49. The CO comes first
    // clockwise from the button's left, so it gets the odd cent.
    const record = srpToShowdown([0, 5]);
    const seats = record.seats.map(seat => ({ ...seat, holeCards: null, startStack: seat.seat === 1 ? 0.49 : seat.startStack }));
    const preflop = record.preflop.map(action => action.seat === 1 ? { ...action, type: "fold" as const } : action);
    const result = settle({ ...record, seats, preflop });
    expect(result.ok).toBe(true);
    if (result.ok) expect([result.payouts[5], result.payouts[0]]).toEqual([6.25, 6.24]);
  });
  it("only takes a blind as large as a short stack", () => {
    // SB posts from a 0.3bb stack: it can only lose 0.3, and chips stay conserved.
    const record = makeHand({ preflop: [[3, "fold"], [4, "fold"], [5, "open", 2.5], [0, "fold"], [1, "fold"], [2, "fold"]], winners: [5] });
    const seats = record.seats.map(seat => seat.seat === 1 ? { ...seat, startStack: 0.3 } : seat);
    const result = settle({ ...record, seats });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.stacks[1]).toBe(0);
      expect(sum(result.stacks)).toBe(500.3);
    }
  });
  it("takes capped rake from a pot that saw a flop, but not from a preflop pot", () => {
    const record = srpToShowdown();
    const replay = replayHandRecord(record, { checkWinners: false });
    if (!replay.ok) throw new Error(replay.message);
    // 5% of 12.5 is 0.625 -> 0.63 (cents), under the 3bb cap.
    expect(settleHand(record, replay.end, replay.preflopState, { percent: 5, capBb: 3 })).toMatchObject({ ok: true, rake: 0.63, payouts: [11.87, 0, 0, 0, 0, 0] });
    expect(settleHand(record, replay.end, replay.preflopState, { percent: 10, capBb: 1 })).toMatchObject({ ok: true, rake: 1, payouts: [11.5, 0, 0, 0, 0, 0] });
    const folded = makeHand({ preflop: [[3, "fold"], [4, "fold"], [5, "open", 2.5], [0, "fold"], [1, "fold"], [2, "fold"]], winners: [5] });
    const preflopReplay = replayHandRecord(folded, { checkWinners: false });
    if (!preflopReplay.ok) throw new Error(preflopReplay.message);
    expect(settleHand(folded, preflopReplay.end, preflopReplay.preflopState, { percent: 5, capBb: 3 })).toMatchObject({ ok: true, rake: 0 });
  });
  it("does not rake a bet nobody called", () => {
    // CO opens 2.5, BTN calls, blinds fold (pot 6.5); CO bets 6 on the flop and BTN folds. Only 6.5 was contested.
    const record = makeHand({
      preflop: [[3, "fold"], [4, "fold"], [5, "open", 2.5], [0, "call", 2.5], [1, "fold"], [2, "fold"]],
      postflop: [["flop", 5, "bet", 6], ["flop", 0, "fold"]], board: ["2c", "7d", "9h"], winners: [5],
    });
    const replay = replayHandRecord(record, { checkWinners: false });
    if (!replay.ok) throw new Error(replay.message);
    const result = settleHand(record, replay.end, replay.preflopState, { percent: 10, capBb: 5 });
    expect(result).toMatchObject({ ok: true, rake: 0.65 });
    if (result.ok) {
      expect(result.stacks[5]).toBe(100 + 4 - 0.65);
      expect(sum(result.stacks) + result.rake).toBe(600);
    }
  });
  it("splits a pot between the chosen winners when no cards were shown", () => {
    // No cards shown: the chosen winners split the 12.5 pot.
    const record = srpToShowdown([0, 5]);
    const result = settle({ ...record, seats: record.seats.map(seat => ({ ...seat, holeCards: null })) });
    expect(result).toMatchObject({ ok: true, payouts: [6.25, 0, 0, 0, 0, 6.25] });
  });
});
