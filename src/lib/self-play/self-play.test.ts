import { describe, expect, it } from "vitest";
import { dealHand, orderedDeck, shuffleDeck } from "./deck";
import { applyAction, canUndo, createHand, handTurn, occupiedSlots, SLOT_POSITIONS, undoAction, visibleBoard, type SelfPlayHand } from "./hand-state";
import { carryStacks, finishHand } from "./settlement";
import { gradePreflop, preflopAdvice, preflopBucket } from "./preflop-advice";
import { postflopPresets, preflopRaisePresets } from "./sizing";
import { NO_RAKE } from "../table-config";
import type { PlayerActionType } from "../game-state";
import type { PostflopActionType } from "../postflop-machine";

const sum = (values: number[]) => Math.round(values.reduce((total, value) => total + value, 0) * 100) / 100;

function play(hand: SelfPlayHand, steps: [PlayerActionType | PostflopActionType, number][]) {
  return steps.reduce((current, [type, amount]) => {
    const result = applyAction(current, type, amount);
    if (!result.ok) throw new Error(`${type} ${amount}: ${result.message}`);
    return result.hand;
  }, hand);
}

describe("deck", () => {
  it("shuffles all 52 cards reproducibly from a seed", () => {
    const deck = shuffleDeck(42);
    expect(new Set(deck).size).toBe(52);
    expect([...deck].sort()).toEqual([...orderedDeck()].sort());
    expect(shuffleDeck(42)).toEqual(deck);
    expect(shuffleDeck(43)).not.toEqual(deck);
  });
  it("deals two cards per occupied slot and five board cards, all distinct", () => {
    const deal = dealHand(7, [false, true, true, false, false, true]);
    expect(deal.holeCards.map(cards => cards?.length ?? 0)).toEqual([0, 2, 2, 0, 0, 2]);
    const dealt = [...deal.holeCards.flatMap(cards => cards ?? []), ...deal.board];
    expect(deal.board).toHaveLength(5);
    expect(new Set(dealt).size).toBe(11);
  });
});

describe("table layout", () => {
  it("seats the blinds first and fills earlier positions as players join", () => {
    const positions = (count: number) => occupiedSlots(count).map(slot => SLOT_POSITIONS[slot]);
    expect(positions(2)).toEqual(["SB", "BB"]);
    expect(positions(3)).toEqual(["BTN", "SB", "BB"]);
    expect(positions(4)).toEqual(["BTN", "SB", "BB", "CO"]);
    expect(positions(6)).toEqual(SLOT_POSITIONS);
    expect(() => occupiedSlots(1)).toThrow();
    expect(() => occupiedSlots(7)).toThrow();
  });
  it("folds empty slots up front so the first seated player acts", () => {
    const hand = createHand({ seed: 1, handNo: 0, stacks: [100, 100, 100] });
    expect(hand.preflop.map(action => action.position)).toEqual(["UTG", "HJ", "CO"]);
    expect(handTurn(hand)).toMatchObject({ kind: "preflop", position: "BTN" });
    expect(canUndo(hand)).toBe(false);
    expect(undoAction(hand)).toBe(hand);
  });
  it("moves the button one player per hand", () => {
    const first = createHand({ seed: 1, handNo: 0, stacks: [100, 90, 80] });
    const second = createHand({ seed: 1, handNo: 1, stacks: [100, 90, 80] });
    expect(first.seatPlayer.slice(0, 3)).toEqual([0, 1, 2]);
    expect(second.seatPlayer.slice(0, 3)).toEqual([1, 2, 0]);
    expect(second.startStacks.slice(0, 3)).toEqual([90, 80, 100]);
  });
});

describe("hand flow", () => {
  it("ends when everyone folds to the big blind and pays it the blinds", () => {
    const hand = play(createHand({ seed: 3, handNo: 0, stacks: [100, 100, 100] }), [["fold", 0], ["fold", 0]]);
    expect(handTurn(hand)).toMatchObject({ kind: "over", street: "preflop", showdown: false, liveSeats: [2] });
    const result = finishHand(hand, NO_RAKE);
    expect(result).toMatchObject({ ok: true, winners: [2] });
    if (result.ok) expect(result.stacks.slice(0, 3)).toEqual([100, 99.5, 100.5]);
  });
  it("plays a heads-up hand street by street to a showdown and conserves chips", () => {
    let hand = createHand({ seed: 11, handNo: 0, stacks: [100, 100] });
    hand = play(hand, [["limp", 1], ["check", 0]]);
    expect(handTurn(hand)).toMatchObject({ kind: "postflop", street: "flop", position: "SB" });
    expect(visibleBoard(hand)).toEqual(hand.board.slice(0, 3));
    hand = play(hand, [["check", 0], ["bet", 1], ["call", 1]]);
    expect(handTurn(hand)).toMatchObject({ kind: "postflop", street: "turn" });
    hand = play(hand, [["check", 0], ["check", 0], ["check", 0], ["check", 0]]);
    expect(handTurn(hand)).toMatchObject({ kind: "over", street: "river", showdown: true });
    expect(visibleBoard(hand)).toEqual(hand.board);
    const result = finishHand(hand, NO_RAKE);
    if (!result.ok) throw new Error(result.message);
    expect(sum(result.stacks)).toBe(600);
    expect(result.payouts.reduce((total, value) => total + value, 0)).toBeCloseTo(4, 10);
  });
  it("runs the board out after a preflop all-in and call", () => {
    const hand = play(createHand({ seed: 5, handNo: 0, stacks: [40, 100] }), [["open", 40], ["call", 40]]);
    const turn = handTurn(hand);
    expect(turn).toMatchObject({ kind: "over", showdown: true });
    expect(visibleBoard(hand, turn)).toHaveLength(5);
    const result = finishHand(hand, NO_RAKE);
    if (!result.ok) throw new Error(result.message);
    expect(sum(result.stacks)).toBe(540);
    expect([[0, 140], [60, 80], [40, 100]]).toContainEqual(result.stacks.slice(1, 3).sort((a, b) => a - b));
  });
  it("rejects an illegal action without changing the hand", () => {
    const hand = createHand({ seed: 2, handNo: 0, stacks: [100, 100] });
    expect(applyAction(hand, "check", 0)).toMatchObject({ ok: false });
    expect(applyAction(hand, "open", 1.5)).toMatchObject({ ok: false });
    expect(hand.preflop.filter(action => !action.implicit)).toHaveLength(0);
  });
  it("undoes postflop actions before preflop ones", () => {
    const hand = play(createHand({ seed: 4, handNo: 0, stacks: [100, 100] }), [["limp", 1], ["check", 0], ["bet", 1]]);
    const undone = undoAction(hand);
    expect(undone.postflop).toHaveLength(0);
    expect(hand.postflop).toHaveLength(1);
    expect(undoAction(undone).preflop.filter(action => !action.implicit)).toHaveLength(1);
  });
});

describe("carryStacks", () => {
  it("returns stacks per player and rebuys a player who cannot post the big blind", () => {
    const hand = createHand({ seed: 1, handNo: 1, stacks: [100, 100, 100] });
    // Slots 0-2 hold players 1, 2, 0.
    expect(carryStacks(hand, [150, 1.5, 49.5, 100, 100, 100], 100)).toEqual([49.5, 150, 100]);
  });
});

describe("sizing", () => {
  it("offers min, the usual open, pot and all-in, clamped to the stack", () => {
    const hand = createHand({ seed: 1, handNo: 0, stacks: [100, 100, 100, 100, 100, 100] });
    const turn = handTurn(hand);
    if (turn.kind !== "preflop") throw new Error("expected preflop");
    expect(preflopRaisePresets("open", hand.preflop, turn.amounts, false)).toEqual([
      { label: "Min", amount: 2 }, { label: "기본", amount: 2.5 }, { label: "Pot", amount: 3.5 }, { label: "All-in", amount: 100 },
    ]);
    expect(preflopRaisePresets("call", hand.preflop, turn.amounts, false)).toEqual([]);
  });
  it("sizes postflop bets from the pot and never above the stack", () => {
    const hand = play(createHand({ seed: 9, handNo: 0, stacks: [3, 100] }), [["limp", 1], ["check", 0]]);
    const turn = handTurn(hand);
    if (turn.kind !== "postflop") throw new Error("expected postflop");
    const bets = postflopPresets("bet", turn.context, turn.seat);
    expect(bets.map(preset => preset.amount)).toEqual([0.66, 1, 1.5, 2]);
    expect(bets.at(-1)).toEqual({ label: "All-in", amount: 2 });
  });
});

describe("preflop advice", () => {
  it("uses only the acting seat's cards and grades by strategy frequency", () => {
    const hand = createHand({ seed: 1, handNo: 0, stacks: [100, 100, 100, 100, 100, 100] });
    const advice = preflopAdvice(hand, 3, ["As", "Ah"]);
    if (!advice) throw new Error("no advice");
    expect(advice.hand).toBe("AA");
    expect(gradePreflop(advice, "fold").verdict).toBe("mistake");
    expect(gradePreflop(advice, "open")).toMatchObject({ bucket: "3-bet", best: "3-bet", verdict: "good" });
    expect(preflopBucket("limp")).toBe("Call");
    expect(preflopAdvice(hand, 3, ["As", "As"])).toBeNull();
  });
});
