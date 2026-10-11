import { describe, expect, it } from "vitest";
import { comboToClass, parseHandRecord } from "./hand-record";
import { replayHandRecord } from "./hand-replay";
import { makeHand, PLAYER, srpToShowdown } from "./__fixtures__/hands";

const roundTrip = (record: unknown) => parseHandRecord(JSON.parse(JSON.stringify(record)));

describe("parseHandRecord", () => {
  it("accepts a well-formed record", () => {
    expect(roundTrip(srpToShowdown()).seats[5].holeCards).toEqual(["Ah", "Kh"]);
  });
  it("converts combos to hand classes", () => {
    expect([comboToClass("As", "Qh"), comboToClass("7c", "Tc"), comboToClass("9d", "9s"), comboToClass("As", "As")]).toEqual(["AQo", "T7s", "99", null]);
  });
  it.each([
    ["a bad id", { id: "x" }],
    ["a repeated card", { board: ["Ah", "7d", "9h"] }],
    ["a slot with the wrong position", { seats: srpToShowdown().seats.map(seat => seat.seat === 0 ? { ...seat, position: "CO" } : seat) }],
    ["a profiled hero", { seats: srpToShowdown().seats.map(seat => seat.isHero ? { ...seat, playerId: PLAYER.e } : seat) }],
    ["one player in two seats", { seats: srpToShowdown().seats.map(seat => seat.seat === 1 ? { ...seat, playerId: PLAYER.a } : seat) }],
    ["too many actions", { preflop: Array(201).fill(srpToShowdown().preflop[0]) }],
    ["an unknown action type", { preflop: [{ ...srpToShowdown().preflop[0], type: "raise" }] }],
  ])("rejects %s", (_, patch) => {
    expect(() => roundTrip({ ...srpToShowdown(), ...patch })).toThrow(/Hand record/);
  });
});

describe("replayHandRecord", () => {
  it("finishes a hand that folds around preflop", () => {
    const result = replayHandRecord(makeHand({ preflop: [[3, "fold"], [4, "fold"], [5, "open", 2.5], [0, "fold"], [1, "fold"], [2, "fold"]], winners: [5] }));
    expect(result).toMatchObject({ ok: true, end: { finished: true, endStreet: "preflop", showdown: false, liveSeats: [5] } });
  });
  it("finishes a river showdown and checks the winner against shown cards", () => {
    expect(replayHandRecord(srpToShowdown())).toMatchObject({ ok: true, end: { finished: true, endStreet: "river", showdown: true, liveSeats: [0, 5] } });
    expect(replayHandRecord(srpToShowdown([5]))).toEqual({ ok: false, message: "winners leave out the best shown hand" });
  });
  it("rejects out-of-turn and illegal actions", () => {
    expect(replayHandRecord(makeHand({ preflop: [[4, "fold"]], winners: [5] }))).toMatchObject({ ok: false, message: "preflop[0] is out of turn" });
    expect(replayHandRecord(makeHand({ preflop: [[3, "open", 1.5]], winners: [3] }))).toMatchObject({ ok: false });
    const record = srpToShowdown();
    expect(replayHandRecord({ ...record, postflop: [record.postflop[1], ...record.postflop] })).toMatchObject({ ok: false, message: "postflop[0] is out of turn" });
  });
  it("reports a hand still in progress", () => {
    const record = srpToShowdown();
    const result = replayHandRecord({ ...record, postflop: record.postflop.slice(0, 5) });
    expect(result).toMatchObject({ ok: true, end: { finished: false, pending: "the hand has not reached showdown" } });
  });
  it("runs out the board after a preflop all-in", () => {
    const record = makeHand({
      stack: 20, preflop: [[3, "fold"], [4, "fold"], [5, "open", 20], [0, "call", 20], [1, "fold"], [2, "fold"]],
      board: ["2c", "7d", "9h", "Ts", "3c"], winners: [5],
    });
    expect(replayHandRecord(record)).toMatchObject({ ok: true, end: { finished: true, showdown: true, liveSeats: [0, 5] } });
    expect(replayHandRecord({ ...record, board: ["2c", "7d", "9h"] })).toMatchObject({ ok: true, end: { finished: false, pending: "the board needs five cards for showdown" } });
  });
  it("requires the last player left to be the winner of an uncontested pot", () => {
    expect(replayHandRecord(makeHand({ preflop: [[3, "fold"], [4, "fold"], [5, "open", 2.5], [0, "fold"], [1, "fold"], [2, "fold"]], winners: [2] })))
      .toEqual({ ok: false, message: "winners include a seat that folded" });
  });
});
