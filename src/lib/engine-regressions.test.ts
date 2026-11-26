import { describe, expect, it } from "vitest";
import type { PlayerAction } from "./game-state";
import type { Position } from "./preflop";
import { deriveBettingState, isBettingRoundComplete, nextPosition } from "./preflop-machine";
import { availablePostflopActions, buildPostflopContext, validatePostflopActionV2 } from "./postflop-hand-state";

const positions: Position[] = ["BTN", "SB", "BB", "UTG", "HJ", "CO"];
const preflop = (seat: number, type: PlayerAction["type"], amount = 0): PlayerAction => ({ id: `${seat}-${type}`, street: "preflop", seat, position: positions[seat], type, amount });

describe("preflop check", () => {
  it("ends a limped round with the big blind's blind still in the pot", () => {
    const actions = [preflop(3, "fold"), preflop(4, "fold"), preflop(5, "fold"), preflop(0, "limp", 1), preflop(1, "limp", 1), preflop(2, "check")];
    const state = deriveBettingState(actions, positions, 100);
    expect(state.contributions.get(2)).toBe(1);
    expect(state.pot).toBe(3);
    expect(isBettingRoundComplete(actions, positions, 100)).toBe(true);
    expect(nextPosition(actions, positions, 100)).toBeNull();
  });
});

describe("postflop short-stack raise", () => {
  // Seat 0 bets 10; seat 1 has only 6 behind and faces it.
  const context = buildPostflopContext({
    actions: [{ id: "b", street: "flop", seat: 0, position: "BTN", type: "bet", amount: 10 }],
    street: "flop", seats: [0, 1], initialRemaining: [100, 6], initialPot: 10,
  });
  it("offers only fold or call to a stack that cannot exceed the bet", () => {
    expect(availablePostflopActions(context, 1)).toEqual(["fold", "call"]);
  });
  it("rejects a raise that does not exceed the current bet, even all-in", () => {
    expect(validatePostflopActionV2(context, 1, "raise", 6)).toMatchObject({ valid: false });
    expect(validatePostflopActionV2(context, 1, "call", 6)).toMatchObject({ valid: true });
  });
});

describe("short all-in recorded as a raise", () => {
  it("is rejected on save; a short all-in below the bet is a call", async () => {
    const { makeHand } = await import("./profiling/__fixtures__/hands");
    const { replayHandRecord } = await import("./profiling/hand-replay");
    // BTN has 10bb: after a 2.5 open call it has 7.5 behind and goes all-in for 7.5 against a 20bb flop bet.
    const base = makeHand({
      preflop: [[3, "fold"], [4, "fold"], [5, "open", 2.5], [0, "call", 2.5], [1, "fold"], [2, "fold"]],
      postflop: [["flop", 5, "bet", 20], ["flop", 0, "raise", 7.5]],
      board: ["2c", "7d", "9h", "Ts", "3c"], winners: [0],
      holeCards: { 5: ["Ah", "Kh"], 0: ["Qs", "Qd"] },
    });
    const record = { ...base, seats: base.seats.map(seat => seat.seat === 0 ? { ...seat, startStack: 10 } : seat) };
    // Stored data must be exactly what was validated, so the save path does not rewrite the action.
    expect(replayHandRecord(record)).toMatchObject({ ok: false });
    const asCall = { ...record, postflop: record.postflop.map(action => action.type === "raise" ? { ...action, type: "call" as const } : action) };
    expect(replayHandRecord(asCall)).toMatchObject({ ok: true, end: { finished: true, showdown: true } });
  });
});
