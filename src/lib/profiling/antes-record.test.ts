import { describe, expect, it } from "vitest";
import { parseHandRecord, type HandRecordV1 } from "./hand-record";
import { replayHandRecord } from "./hand-replay";
import { settleHand } from "./settle";
import { makeHand, srpToShowdown } from "./__fixtures__/hands";
import { buildHandRecord } from "./build-record";

const roundTrip = (record: unknown) => parseHandRecord(JSON.parse(JSON.stringify(record)));
const sum = (values: number[]) => Math.round(values.reduce((total, value) => total + value, 0) * 100) / 100;

function settle(record: HandRecordV1) {
  const replay = replayHandRecord(record, { checkWinners: false });
  if (!replay.ok) throw new Error(replay.message);
  return { replay, settlement: settleHand(record, replay.end, replay.preflopState) };
}

describe("hand record antes", () => {
  it("keeps a record without an ante byte-identical, so stored hashes stay stable", () => {
    const record = roundTrip(srpToShowdown());
    expect("ante" in record).toBe(false);
    expect(JSON.stringify(roundTrip(record))).toBe(JSON.stringify(record));
  });
  it("round-trips an ante and rejects a malformed one", () => {
    expect(roundTrip({ ...srpToShowdown(), ante: { kind: "bb", amount: 1 } }).ante).toEqual({ kind: "bb", amount: 1 });
    for (const ante of [{ kind: "none", amount: 1 }, { kind: "seat", amount: 0 }, { kind: "seat", amount: 11 }, { kind: "seat", amount: 0.125 }, "1"]) {
      expect(() => roundTrip({ ...srpToShowdown(), ante })).toThrow(/ante/);
    }
  });
  it("builds no ante key without an ante", () => {
    const base = { id: "11111111-1111-4111-8111-111111111111", playedAt: "2026-10-11T00:00:00.000Z", tableSize: 6 as const, heroSeat: 2, heroHand: "72o", stacks: Array(6).fill(100), seatPlayers: Array(6).fill(null), preflop: [], postflop: [], board: [], holeCards: {}, winners: [0] };
    expect("ante" in buildHandRecord({ ...base, ante: { kind: "none", amount: 0 } })).toBe(false);
    expect(buildHandRecord({ ...base, ante: { kind: "seat", amount: 0.1 } }).ante).toEqual({ kind: "seat", amount: 0.1 });
  });
});

describe("replay and settlement with antes", () => {
  it("adds seat antes to the pot and pays them to the winner", () => {
    // Six seats post 0.1 each: the showdown pot grows from 12.5 to 13.1.
    const { replay, settlement } = settle({ ...srpToShowdown(), ante: { kind: "seat", amount: 0.1 } });
    expect(replay.preflopState.pot).toBeCloseTo(7.1, 10);
    expect(settlement).toMatchObject({ ok: true, payouts: [13.1, 0, 0, 0, 0, 0] });
    if (settlement.ok) {
      expect(settlement.stacks).toEqual([107.5, 99.4, 98.9, 99.9, 99.9, 94.4]);
      expect(sum(settlement.stacks)).toBe(600);
    }
  });
  it("does not refund a big blind ante as an uncalled bet when everyone folds to the big blind", () => {
    const record = { ...makeHand({ preflop: [[3, "fold"], [4, "fold"], [5, "fold"], [0, "fold"], [1, "fold"]], winners: [2] }), ante: { kind: "bb" as const, amount: 1 } };
    const { settlement } = settle(record);
    // BB posted 1 blind and 1 ante; it wins its own chips back plus the small blind.
    expect(settlement).toMatchObject({ ok: true, stacks: [100, 99.5, 100.5, 100, 100, 100] });
  });
  it("treats a raise to the stack left after the ante as all-in", () => {
    // The CO has 20bb and posts a 0.5 ante: an open to 19.5 is all-in and legal; 20 is more than it has.
    const base = makeHand({ preflop: [[3, "fold"], [4, "fold"], [5, "open", 19.5], [0, "fold"], [1, "fold"], [2, "fold"]], winners: [5] });
    const seats = base.seats.map(seat => seat.seat === 5 ? { ...seat, startStack: 20 } : seat);
    const record = { ...base, seats, ante: { kind: "seat" as const, amount: 0.5 } };
    expect(replayHandRecord(record)).toMatchObject({ ok: true });
    expect(replayHandRecord({ ...record, preflop: record.preflop.map(action => action.seat === 5 ? { ...action, amount: 20 } : action) })).toMatchObject({ ok: false });
  });
  it("refuses a record where a seat cannot cover its ante and blind", () => {
    const base = makeHand({ preflop: [[3, "fold"], [4, "fold"], [5, "open", 2.5], [0, "fold"], [1, "fold"], [2, "fold"]], winners: [5] });
    const seats = base.seats.map(seat => seat.seat === 1 ? { ...seat, startStack: 0.6 } : seat);
    expect(replayHandRecord({ ...base, seats, ante: { kind: "seat", amount: 0.2 } })).toEqual({ ok: false, message: "a seat cannot cover its ante and blind" });
  });
});
