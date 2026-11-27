import { afterEach, describe, expect, it, vi } from "vitest";
import type { WasmSolveRequest } from "../wasm-solver/request";
import { FIXTURE_BOARD, fixtureIndex, fixtureScenario, fixtureSolution } from "./fixture";
import { resetFlopLibraryCache } from "./loader";
import { queryFlopLibrary, stackApproxNote } from "./query";

const reply = (body: string) => new Response(body, { status: 200, headers: { "content-type": "application/json" } });
const serve = (solution = fixtureSolution()) => vi.fn(async (url: string | URL | Request) => reply(String(url).endsWith("index.json") ? fixtureIndex() : solution));
const request = (patch: Partial<WasmSolveRequest> = {}): WasmSolveRequest => ({
  board: FIXTURE_BOARD, hero: "AhAs", oopRange: fixtureScenario.oopRange, ipRange: fixtureScenario.ipRange, pot: 550, stacks: [9750, 9750],
  iterations: 300, betSizes: [[[1, 2]], [[3, 5]]], maxRaises: 2, history: [], timeBudgetMs: 4000, ...patch,
});

afterEach(() => resetFlopLibraryCache());

describe("queryFlopLibrary", () => {
  it("answers a stored spot with strategy and per-size details", async () => {
    const answer = await queryFlopLibrary(request(), serve());
    if (!("raw" in answer)) throw new Error(JSON.stringify(answer));
    expect(answer).toMatchObject({ scenarioLabel: fixtureScenario.label, generatedAt: fixtureScenario.generatedAt });
    expect(answer.stackApprox).toBeUndefined();
    expect(JSON.parse(answer.raw).details).toEqual([
      { action: "check", label: "Check", frequency: 0.6, ev: 5 }, { action: "bet", label: "Bet 1/2", frequency: 0.4, ev: 5.2 },
    ]);
  });
  it("reports a stack approximation, a miss, and a missing library", async () => {
    expect(await queryFlopLibrary(request({ stacks: [9000, 9000] }), serve())).toMatchObject({ stackApprox: { libraryStack: 97.5, requestedStack: 90 } });
    expect(await queryFlopLibrary(request({ pot: 551 }), serve())).toEqual({ miss: "scenario" });
    resetFlopLibraryCache();
    expect(await queryFlopLibrary(request(), vi.fn(async () => new Response("", { status: 404 })))).toEqual({ unavailable: true });
  });
  it("refuses a solution file from an older spec", async () => {
    const stale = fixtureSolution({ build: { iterations: 61, exploitability: 0.21, elapsedMs: 1, specHash: "fedcba9876543210" } });
    expect(await queryFlopLibrary(request(), serve(stale))).toEqual({ miss: "stale" });
  });
  it("labels the stack approximation", () => {
    expect(stackApproxNote({ libraryStack: 97.5, requestedStack: 90 })).toBe("APPROX STACK: 97.5BB 계산으로 90BB 대체");
  });
});
