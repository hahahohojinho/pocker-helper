import { describe, expect, it } from "vitest";
import type { WasmSolveRequest } from "../wasm-solver/request";
import { parseFlopIndex, parseFlopSolution } from "./format";
import { FIXTURE_BOARD, fixtureIndex, fixtureScenario, fixtureSolution } from "./fixture";
import { answerFromSolution, historyKey, matchFlopLibrary, type FlopLibraryMatch } from "./lookup";

type StrategyRow = { action: string; frequency: number; ev: number };

const index = parseFlopIndex(fixtureIndex());
const solution = parseFlopSolution(fixtureSolution(), fixtureScenario.id, FIXTURE_BOARD);
const request = (patch: Partial<WasmSolveRequest> = {}): WasmSolveRequest => ({
  board: FIXTURE_BOARD, hero: "AhAs", oopRange: fixtureScenario.oopRange, ipRange: fixtureScenario.ipRange, pot: 550, stacks: [9750, 9750],
  iterations: 300, betSizes: [[[1, 2]], [[3, 5]]], maxRaises: 2, history: [], timeBudgetMs: 4000, ...patch,
});
function answer(patch: Partial<WasmSolveRequest> = {}) {
  const match = matchFlopLibrary(index, request(patch));
  if ("miss" in match) throw new Error(match.miss);
  const result = answerFromSolution(solution, match);
  if (typeof result !== "string") throw new Error(result.miss);
  return JSON.parse(result) as { strategy: StrategyRow[]; note?: string } & Record<string, unknown>;
}
const row = (result: { strategy: StrategyRow[] }, action: string) => result.strategy.find(item => item.action === action)!;

describe("historyKey", () => {
  it("names the four stored flop decisions and nothing else", () => {
    expect(historyKey([])).toBe("");
    expect(historyKey([{ action: "check" }])).toBe("x");
    expect(historyKey([{ action: "bet", size: [1, 2] }])).toBe("b1/2");
    expect(historyKey([{ action: "check" }, { action: "bet", size: [3, 4] }])).toBe("x,b3/4");
    expect(historyKey([{ action: "check" }, { action: "check" }])).toBeNull();
    expect(historyKey([{ action: "bet", size: [1, 2] }, { action: "raise", size: [3, 5] }])).toBeNull();
    expect(historyKey([{ action: "allin" }])).toBeNull();
  });
});

describe("matchFlopLibrary", () => {
  it("matches the exact request", () => {
    expect(matchFlopLibrary(index, request())).toMatchObject({ board: FIXTURE_BOARD, nodeKey: "", hero: "AhAs" });
  });
  it("misses when anything in the solve differs", () => {
    const misses: [Partial<WasmSolveRequest>, string][] = [
      [{ oopRange: "AA,KK,72o,AsQh:0.01" }, "scenario"], [{ pot: 551 }, "scenario"], [{ stacks: [9750, 9749] }, "scenario"],
      [{ betSizes: [[[3, 5]], [[3, 5]]] }, "scenario"], [{ maxRaises: 3 }, "scenario"], [{ board: "Kc7d3h" }, "board"],
      [{ board: "Kc7d2h5s" }, "not-flop"], [{ history: [{ action: "check" }, { action: "check" }] }, "line"],
    ];
    for (const [patch, reason] of misses) expect(matchFlopLibrary(index, request(patch))).toEqual({ miss: reason });
  });
  it("maps a suit-permuted board and hero to the stored flop", () => {
    expect(matchFlopLibrary(index, request({ board: "Kh7s2d", hero: "AdAc" }))).toMatchObject({ board: FIXTURE_BOARD, hero: "AhAs" });
    expect(answer({ board: "Kh7s2d", hero: "AdAc" })).toEqual(answer());
  });
});

describe("answerFromSolution", () => {
  it("returns Hero's strategy with EV in BB", () => {
    expect(answer()).toMatchObject({ source: "flop-library", best_action: "check", exploitability: 0.21, strategy: [{ action: "check", frequency: 0.6, ev: 5 }, { action: "bet", frequency: 0.4, ev: 5.2 }] });
  });
  it("merges raise sizes into one raise with a weighted EV", () => {
    const raise = row(answer({ hero: "KdKh", history: [{ action: "bet", size: [1, 2] }] }), "raise");
    expect(raise.frequency).toBeCloseTo(0.4, 10);
    expect(raise.ev).toBeCloseTo((0.3 * 4 + 0.1 * 2) / 0.4, 10);
  });
  it("notes an unreached hand and shows the best size for a category it never takes", () => {
    const result = answer({ hero: "QhQs", history: [{ action: "bet", size: [1, 2] }] });
    expect(result.note).toContain("도달하지 않습니다");
    expect(row(result, "raise").ev).toBeCloseTo(-0.8, 10);
  });
  it("misses a node or hero combo the file does not have", () => {
    const match = matchFlopLibrary(index, request()) as FlopLibraryMatch;
    expect(answerFromSolution(solution, { ...match, nodeKey: "x" })).toEqual({ miss: "node" });
    expect(answerFromSolution(solution, { ...match, hero: "QdQc" })).toEqual({ miss: "hero" });
  });
  it("refuses a file solved for an older spec", () => {
    const match = matchFlopLibrary(index, request()) as FlopLibraryMatch;
    expect(answerFromSolution(solution, { ...match, scenario: { ...match.scenario, specHash: "fedcba9876543210" } })).toEqual({ miss: "stale" });
  });
});
