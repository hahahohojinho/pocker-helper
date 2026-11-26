import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WasmSolverEngine } from "../wasm-solver/engine";
import { applyAction, createHand, handTurn, type SelfPlayHand } from "./hand-state";
import { gradePostflop, headsUpRequest, parsePostflopAdvice } from "./postflop-advice";
import type { PlayerActionType } from "../game-state";
import type { PostflopActionType } from "../postflop-machine";

const wasmPath = join(process.cwd(), "public", "solver", "rangelab_dcfr_wasm.wasm");
const play = (hand: SelfPlayHand, steps: [PlayerActionType | PostflopActionType, number][]) => steps.reduce((current, [type, amount]) => {
  const result = applyAction(current, type, amount);
  if (!result.ok) throw new Error(`${type} ${amount}: ${result.message}`);
  return result.hand;
}, hand);

describe.skipIf(!existsSync(wasmPath))("self-play river advice (real wasm)", () => {
  it("solves the acting seat's river decision with per-size EVs and grades a choice", async () => {
    const engine = await WasmSolverEngine.load(readFileSync(wasmPath));
    // BTN opens, BB calls, both check flop and turn: the BB acts first on the river.
    const hand = play(createHand({ seed: 21, handNo: 0, stacks: Array(6).fill(100) }), [
      ["fold", 0], ["fold", 0], ["fold", 0], ["open", 2.5], ["fold", 0], ["call", 2.5],
      ["check", 0], ["check", 0], ["check", 0], ["check", 0],
    ]);
    const turn = handTurn(hand);
    if (turn.kind !== "postflop") throw new Error("expected a river decision");
    expect(turn.street).toBe("river");
    const request = headsUpRequest(hand, turn, hand.holeCards[turn.seat]!, "wasm")!;
    const advice = parsePostflopAdvice(engine.solve({ ...request, timeBudgetMs: undefined, iterations: 200 }));
    expect(advice.result.actions.map(action => action.action).sort()).toEqual(["bet", "check"]);
    expect(advice.details.length).toBeGreaterThanOrEqual(2);
    const grade = gradePostflop(advice, "check", 0, turn.context, turn.seat);
    expect(grade).not.toBeNull();
    expect(grade!.evLoss).toBeGreaterThanOrEqual(0);
  }, 60_000);
});
