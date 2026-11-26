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
    expect(result).toEqual({ ok: true, stacks: [107, 99.5, 99, 100, 100, 94.5], payouts: [12.5, 0, 0, 0, 0, 0] });
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
  it("splits a pot between the chosen winners when no cards were shown", () => {
    // No cards shown: the chosen winners split the 12.5 pot.
    const record = srpToShowdown([0, 5]);
    const result = settle({ ...record, seats: record.seats.map(seat => ({ ...seat, holeCards: null })) });
    expect(result).toMatchObject({ ok: true, payouts: [6.25, 0, 0, 0, 0, 6.25] });
  });
});
