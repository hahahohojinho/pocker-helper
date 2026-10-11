import { describe, expect, it } from "vitest";
import { buildHandRecord, parseSeatPlayers, rotateForNextHand, rotateHeroSeat } from "./build-record";
import { parseHandRecord } from "./hand-record";
import { replayHandRecord } from "./hand-replay";
import { PLAYER, srpToShowdown } from "./__fixtures__/hands";

describe("buildHandRecord", () => {
  const base = srpToShowdown();
  const input = {
    id: base.id, playedAt: base.playedAt, tableSize: 6 as const, heroSeat: 2, heroHand: "72o", stacks: Array(6).fill(100),
    seatPlayers: [PLAYER.a, PLAYER.b, PLAYER.e, PLAYER.c, PLAYER.d, PLAYER.e], preflop: base.preflop, postflop: base.postflop,
    board: [...base.board], holeCards: { 0: ["Qs", "Qd"], 5: ["Ah", "Kh"], 2: ["As", "Qh"], 3: ["Kd", ""] }, winners: [0],
  };
  it("builds a record that parses and replays", () => {
    const record = parseHandRecord(buildHandRecord(input));
    expect(replayHandRecord(record)).toMatchObject({ ok: true, end: { finished: true, showdown: true } });
    expect(record.seats[2]).toMatchObject({ isHero: true, playerId: null, holeCards: null });
    expect(record.seats[3].holeCards).toBeNull();
  });
  it("keeps the hero's cards when they match the typed hand", () => {
    expect(buildHandRecord({ ...input, heroHand: "aqo" }).seats[2].holeCards).toEqual(["As", "Qh"]);
  });
});

describe("seat rotation", () => {
  it("moves the button one seat", () => {
    expect(rotateForNextHand(["btn", "sb", "bb", "utg", "hj", "co"])).toEqual(["sb", "bb", "utg", "hj", "co", "btn"]);
    expect(rotateHeroSeat(2, 6)).toBe(1);
    expect(rotateHeroSeat(0, 8)).toBe(7);
  });
  it("parses saved assignments defensively", () => {
    expect(parseSeatPlayers(JSON.stringify({ 6: [PLAYER.a, null, null, null, null, null], 8: ["bad"] }))).toEqual({ 6: [PLAYER.a, null, null, null, null, null], 8: Array(8).fill(null) });
    expect(parseSeatPlayers("{")[6]).toEqual(Array(6).fill(null));
  });
});
