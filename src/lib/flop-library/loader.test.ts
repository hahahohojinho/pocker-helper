import { afterEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_BOARD, fixtureIndex, fixtureScenario, fixtureSolution } from "./fixture";
import { loadFlopIndex, loadFlopSolution, resetFlopLibraryCache } from "./loader";

const reply = (body: string, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers: { "content-type": "application/json", ...headers } });

afterEach(() => {
  resetFlopLibraryCache();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("flop library loader", () => {
  it("loads and caches the index and a solution", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => reply(String(url).endsWith("index.json") ? fixtureIndex() : fixtureSolution()));
    expect((await loadFlopIndex(fetchImpl))?.scenarios).toHaveLength(1);
    expect((await loadFlopSolution(fixtureScenario.id, FIXTURE_BOARD, fetchImpl))?.board).toBe(FIXTURE_BOARD);
    await loadFlopSolution(fixtureScenario.id, FIXTURE_BOARD, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenLastCalledWith(`/data/flop-library/${fixtureScenario.id}/${FIXTURE_BOARD}.json`);
  });
  it("treats a missing library as unavailable and retries after a minute", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => new Response("", { status: 404 }));
    expect(await loadFlopIndex(fetchImpl)).toBeNull();
    expect(await loadFlopIndex(fetchImpl)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_001);
    await loadFlopIndex(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("skips HTML fallbacks, oversized files, and files for another board", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await loadFlopIndex(async () => reply("<html>", { "content-type": "text/html" }))).toBeNull();
    expect(await loadFlopSolution(fixtureScenario.id, FIXTURE_BOARD, async () => reply("{}", { "content-length": "999999999" }))).toBeNull();
    expect(await loadFlopSolution(fixtureScenario.id, "Ks7d3c", async () => reply(fixtureSolution()))).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it("refuses path-like ids and boards without fetching", async () => {
    const fetchImpl = vi.fn();
    expect(await loadFlopSolution("../secret", FIXTURE_BOARD, fetchImpl)).toBeNull();
    expect(await loadFlopSolution(fixtureScenario.id, "../../x", fetchImpl)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
