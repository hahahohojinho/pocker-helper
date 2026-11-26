import { describe, expect, it } from "vitest";
import { applyAction, createHand, handTurn, type SelfPlayHand } from "./hand-state";
import { modelAdvice, multiwayRequest } from "./model-advice";
import { gradePostflop } from "./postflop-advice";
import type { PlayerActionType } from "../game-state";
import type { PostflopActionType } from "../postflop-machine";

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

describe("modelAdvice", () => {
  it("prices check and every offered bet size against all live opponents in a 6-way pot", () => {
    // Everyone limps, the big blind checks: six players see the flop.
    const hand = play(createHand({ seed: 33, handNo: 0, stacks: Array(6).fill(100) }), [["limp", 1], ["limp", 1], ["limp", 1], ["limp", 1], ["limp", 1], ["check", 0]]);
    const turn = postflopTurn(hand);
    const advice = modelAdvice(hand, turn, hand.holeCards[turn.seat]!);
    expect(advice.kind).toBe("model");
    expect(advice.details.map(row => row.action)).toContain("check");
    const bets = advice.details.filter(row => row.action === "bet");
    expect(bets.length).toBeGreaterThanOrEqual(5);
    expect(bets.every(row => typeof row.amount === "number" && Number.isFinite(row.ev))).toBe(true);
    expect(advice.result.actions.find(action => action.action === advice.result.bestAction)?.frequency).toBe(100);
    // A bet is graded against the exact model size it matches.
    const grade = gradePostflop(advice, "bet", bets[1].amount!, turn.context, turn.seat);
    expect(grade?.chosenLabel).toBe(bets[1].label);
    expect(grade!.evLoss).toBeGreaterThanOrEqual(0);
  });
});

describe("multiwayRequest", () => {
  // BTN limps, SB completes, BB checks; everyone checks the flop: a 3-way turn with the SB first to act.
  const threeWayTurn = () => play(createHand({ seed: 8, handNo: 0, stacks: [100, 100, 100] }), [["limp", 1], ["limp", 1], ["check", 0], ["check", 0], ["check", 0], ["check", 0]]);
  it("builds a 3-way turn request with the acting seat's cards as hero", () => {
    const hand = threeWayTurn();
    const turn = postflopTurn(hand);
    expect(turn.street).toBe("turn");
    const request = multiwayRequest(hand, turn, hand.holeCards[turn.seat]!);
    expect(request).not.toBeNull();
    expect(request!.players).toHaveLength(3);
    expect(request!.heroSeat).toBe(0);
    expect(request!.hero).toBe(hand.holeCards[turn.seat]!.join(""));
    expect(request!.board).toBe(hand.board.slice(0, 4).join(""));
  });
  it("has no request for a flop or a heads-up street", () => {
    const flop = play(createHand({ seed: 8, handNo: 0, stacks: [100, 100, 100] }), [["limp", 1], ["limp", 1], ["check", 0]]);
    expect(multiwayRequest(flop, postflopTurn(flop), flop.holeCards[postflopTurn(flop).seat]!)).toBeNull();
  });
});
