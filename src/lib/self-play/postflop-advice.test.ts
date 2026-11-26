import { describe, expect, it } from "vitest";
import { applyAction, createHand, handTurn, type SelfPlayHand } from "./hand-state";
import { adviceKey, checkedDown, gradePostflop, headsUpRequest, labelAmount, parsePostflopAdvice, streetStartSeats } from "./postflop-advice";
import type { PostflopActionType } from "../postflop-machine";
import type { PlayerActionType } from "../game-state";

function play(hand: SelfPlayHand, steps: [PlayerActionType | PostflopActionType, number][]) {
  return steps.reduce((current, [type, amount]) => {
    const result = applyAction(current, type, amount);
    if (!result.ok) throw new Error(`${type} ${amount}: ${result.message}`);
    return result.hand;
  }, hand);
}
function postflopTurn(hand: SelfPlayHand) {
  const turn = handTurn(hand);
  if (turn.kind !== "postflop") throw new Error("expected a postflop turn");
  return turn;
}

// Six seats: UTG..CO fold, BTN opens, SB folds, BB calls: a heads-up flop with BB first to act.
const headsUpFlop = () => play(createHand({ seed: 21, handNo: 0, stacks: Array(6).fill(100) }), [["fold", 0], ["fold", 0], ["fold", 0], ["open", 2.5], ["fold", 0], ["call", 2.5]]);

describe("headsUpRequest", () => {
  it("solves for the acting seat with its own cards and never the other seat's", () => {
    const hand = headsUpFlop();
    const turn = postflopTurn(hand);
    expect(turn.position).toBe("BB");
    const request = headsUpRequest(hand, turn, hand.holeCards[turn.seat]!, "native");
    expect(request).not.toBeNull();
    expect(request!.hero).toBe(hand.holeCards[turn.seat]!.join(""));
    expect(request!.board).toBe(hand.board.slice(0, 3).join(""));
    expect(request!.pot).toBe(550);
    // Whatever the BTN holds, the BB's request is the same.
    const swapped = { ...hand, holeCards: hand.holeCards.map((cards, seat) => seat === 0 ? ["2c", "3d"] as [string, string] : cards) };
    expect(adviceKey(headsUpRequest(swapped, postflopTurn(swapped), hand.holeCards[turn.seat]!, "native")!)).toBe(adviceKey(request!));
  });
  it("returns null when the street started with more than two players", () => {
    const hand = play(createHand({ seed: 8, handNo: 0, stacks: [100, 100, 100] }), [["limp", 1], ["limp", 1], ["check", 0]]);
    expect(hand.preflop.some(action => action.type === "check")).toBe(true);
    const turn = postflopTurn(hand);
    expect(streetStartSeats(hand, "flop")).toHaveLength(3);
    expect(headsUpRequest(hand, turn, hand.holeCards[turn.seat]!, "native")).toBeNull();
  });
  it("ignores iteration planning in the cache key and flags check-down trees", () => {
    const hand = headsUpFlop();
    const turn = postflopTurn(hand);
    const request = headsUpRequest(hand, turn, hand.holeCards[turn.seat]!, "wasm", 120)!;
    expect(request.iterationCostNs).toBe(120);
    expect(adviceKey(request)).toBe(adviceKey(headsUpRequest(hand, turn, hand.holeCards[turn.seat]!, "wasm", 999)!));
    expect(checkedDown("native", turn)).toBe(true);
  });
});

describe("grading", () => {
  const raw = JSON.stringify({
    source: "dcfr-native", best_action: "check",
    strategy: [{ action: "check", frequency: 0.7, ev: 2 }, { action: "bet", frequency: 0.3, ev: 2 }],
    details: [
      { action: "check", label: "check", frequency: 0.7, ev: 2 },
      { action: "bet", label: "bet 33%", frequency: 0.3, ev: 2 },
      { action: "bet", label: "bet 75%", frequency: 0, ev: 1.4 },
      { action: "bet", label: "allin", frequency: 0, ev: -3 },
    ],
  });
  it("matches a bet to the nearest solved size and reports EV loss against the best option", () => {
    const hand = headsUpFlop();
    const turn = postflopTurn(hand);
    const advice = parsePostflopAdvice(raw);
    expect(labelAmount("bet 33%", turn.context, turn.seat)).toBeCloseTo(1.82, 2);
    expect(labelAmount("bet 3/2", turn.context, turn.seat)).toBeCloseTo(8.25, 2);
    expect(labelAmount("allin", turn.context, turn.seat)).toBe(97.5);
    expect(labelAmount("donk", turn.context, turn.seat)).toBeNull();
    expect(gradePostflop(advice, "check", 0, turn.context, turn.seat)).toMatchObject({ chosenLabel: "check", evLoss: 0 });
    const big = gradePostflop(advice, "bet", 4, turn.context, turn.seat)!;
    expect(big.chosenLabel).toBe("bet 75%");
    expect(big.evLoss).toBeCloseTo(0.6, 10);
    expect(gradePostflop(advice, "bet", 97.5, turn.context, turn.seat)!.evLoss).toBeCloseTo(5, 10);
    expect(gradePostflop(advice, "fold", 0, turn.context, turn.seat)).toBeNull();
  });
});
