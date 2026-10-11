import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildNodesRequest, DEFAULTS, nodePlan, parseArgs, quantize, runScenario, scanStored, solveWithAdapter, specHash, toSolutionFile, writeIndex } from "./build-flop-library.mjs";
import { parseFlopIndex, parseFlopSolution } from "../src/lib/flop-library/format";

const spec = {
  id: "6max-100bb-srp-btn-bb", label: "BTN vs BB", oop: "BB", ip: "BTN", pot: 550, stacks: [9750, 9750],
  betSizes: [[[1, 2]], [[3, 5]]], maxRaises: 2, oopRange: "AA,KK", ipRange: "QQ", flops: [], generatedAt: "2026-10-11",
};
const options = { ...DEFAULTS, budgetMs: 1000, iterations: 50 };

/** What `--json-nodes` returns: OOP has AhAs, KhKd; IP has QhQs. */
function adapterResult(exploitability = 0.3) {
  const oopNode = { player: "oop", actions: [{ category: "check", label: "Check" }, { category: "bet", label: "Bet(1/2)" }], freq: [0.3333, 0.6667, 1, 0], ev: [510.4, 499.6, 120, 90], unreached: [] };
  const ipNode = { player: "ip", actions: [{ category: "check", label: "Check" }, { category: "bet", label: "Bet(1/2)" }], freq: [0.5, 0.5], ev: [100, 101], unreached: [] };
  const facing = player => ({ player, actions: [{ category: "fold", label: "Fold" }, { category: "call", label: "Call" }], freq: player === "ip" ? [0.2, 0.8] : [0, 1, 0.1, 0.9], ev: player === "ip" ? [0, 50] : [0, 40, 0, 30], unreached: player === "ip" ? [0] : [] });
  return { iterations: 61, exploitability, elapsedMs: 9000, combos: { oop: "AhAsKhKd", ip: "QhQs" }, nodes: [oopNode, ipNode, facing("ip"), facing("oop")] };
}

let directory;
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined; });
const tempOptions = () => { directory = mkdtempSync(join(tmpdir(), "flop-library-")); return { ...options, outDir: directory }; };

describe("arguments and requests", () => {
  it("parses options and rejects bad values", () => {
    expect(parseArgs(["--scenarios", "a,b", "--budget-ms", "5000", "--limit", "3", "--redo-above", "0.5"])).toMatchObject({ scenarios: ["a", "b"], budgetMs: 5000, limit: 3, redoAbove: 0.5 });
    expect(() => parseArgs(["--budget-ms", "-1"])).toThrow();
    expect(() => parseArgs(["--budget-ms", "999999"])).toThrow();
    expect(() => parseArgs(["--limit"])).toThrow();
    expect(() => parseArgs(["--unknown", "1"])).toThrow();
  });
  it("asks the adapter for the four stored nodes with the scenario's tree", () => {
    expect(nodePlan(spec).map(node => node.key)).toEqual(["", "x", "b1/2", "x,b1/2"]);
    const payload = buildNodesRequest(spec, "Kc7d2h", options);
    expect(payload.request).toEqual({ board: "Kc7d2h", oopRange: "AA,KK", ipRange: "QQ", pot: 550, stacks: [9750, 9750], betSizes: spec.betSizes, maxRaises: 2, iterations: 50, timeBudgetMs: 1000 });
    expect(payload.nodes[3]).toEqual([{ action: "check" }, { action: "bet", size: [1, 2] }]);
  });
});

describe("quantize", () => {
  it("keeps exact totals of 1000", () => {
    for (const shares of [[1 / 3, 1 / 3, 1 / 3], [0.6667, 0.3333], [0.0004, 0.9996], [0.2, 0.2, 0.2, 0.2, 0.2]]) expect(quantize(shares).reduce((a, b) => a + b, 0)).toBe(1000);
    expect(quantize([NaN, 0])).toEqual([500, 500]);
  });
});

describe("solution files", () => {
  it("are accepted by the app's parser", () => {
    const solution = parseFlopSolution(toSolutionFile(spec, "Kc7d2h", adapterResult()), spec.id, "Kc7d2h");
    expect(solution.nodes[""].freq).toEqual([333, 667, 1000, 0]);
    expect(solution.nodes[""].ev).toEqual([510, 500, 120, 90]);
    expect(solution.nodes["b1/2"].unreached).toEqual([0]);
  });
  it("refuse a result with the wrong number of nodes", () => {
    expect(() => toSolutionFile(spec, "Kc7d2h", { ...adapterResult(), nodes: [] })).toThrow();
  });
});

describe("runScenario", () => {
  const boards = ["Kc7d2h", "As2c3d", "AcKd5h"];
  it("solves missing flops, skips finished ones, logs failures, and indexes only stored files", async () => {
    const opts = tempOptions();
    const solve = vi.fn(async payload => { if (payload.request.board === "As2c3d") throw new Error("boom"); return adapterResult(); });
    const stored = scanStored(spec, boards, opts.outDir);
    const deps = { solve, log: vi.fn(), stored, onProgress: () => writeIndex([spec], boards, new Map([[spec.id, stored]]), opts.outDir) };
    expect(await runScenario(spec, boards, opts, deps)).toEqual({ solved: 2, failed: 1, pending: 3 });
    expect(deps.log.mock.calls.some(([line]) => line.includes("As2c3d failed: boom"))).toBe(true);
    const index = parseFlopIndex(readFileSync(join(opts.outDir, "index.json"), "utf8"));
    expect(index.scenarios[0]).toMatchObject({ flops: ["Kc7d2h", "AcKd5h"], specHash: specHash(spec) });
    solve.mockClear();
    await runScenario(spec, boards, opts, { ...deps, stored: scanStored(spec, boards, opts.outDir) });
    expect(solve.mock.calls.map(([payload]) => payload.request.board)).toEqual(["As2c3d"]);
  });
  it("re-solves corrupt files and files above --redo-above, up to --limit, keeping the better result", async () => {
    const opts = { ...tempOptions(), redoAbove: 0.5, limit: 1 };
    const first = { solve: async () => adapterResult(0.9), log: vi.fn(), stored: new Map(), onProgress: () => {} };
    await runScenario(spec, ["Kc7d2h"], { ...opts, redoAbove: Infinity }, first);
    writeFileSync(join(opts.outDir, spec.id, "AcKd5h.json"), "{broken");
    const worse = { ...first, solve: vi.fn(async () => adapterResult(1.5)), stored: scanStored(spec, ["Kc7d2h", "AcKd5h"], opts.outDir) };
    expect(await runScenario(spec, ["Kc7d2h", "AcKd5h"], opts, worse)).toMatchObject({ solved: 1, pending: 1 });
    expect(worse.stored.get("Kc7d2h")).toBe(0.9);
    const better = { ...first, solve: vi.fn(async () => adapterResult(0.2)), stored: scanStored(spec, ["Kc7d2h", "AcKd5h"], opts.outDir) };
    expect(await runScenario(spec, ["Kc7d2h", "AcKd5h"], { ...opts, limit: 5 }, better)).toMatchObject({ solved: 2, pending: 2 });
    expect(scanStored(spec, ["Kc7d2h", "AcKd5h"], opts.outDir)).toEqual(new Map([["Kc7d2h", 0.2], ["AcKd5h", 0.2]]));
  });
  it("treats files solved for another spec as missing", async () => {
    const opts = tempOptions();
    await runScenario(spec, ["Kc7d2h"], opts, { solve: async () => adapterResult(), log: vi.fn(), stored: new Map(), onProgress: () => {} });
    expect(scanStored(spec, ["Kc7d2h"], opts.outDir).size).toBe(1);
    expect(scanStored({ ...spec, oopRange: "AA,KK,QQ" }, ["Kc7d2h"], opts.outDir).size).toBe(0);
  });
});

describe("solveWithAdapter", () => {
  function fakeSpawn(stdout, code = 0) {
    return () => {
      const child = new EventEmitter();
      Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() });
      child.stdin.on("finish", () => { child.stdout.end(stdout); setImmediate(() => child.emit("close", code)); });
      return child;
    };
  }
  it("returns the result or the reported error", async () => {
    await expect(solveWithAdapter("adapter", {}, { spawnImpl: fakeSpawn(JSON.stringify({ ok: true, result: { iterations: 1 } })), timeoutMs: 1000 })).resolves.toEqual({ iterations: 1 });
    await expect(solveWithAdapter("adapter", {}, { spawnImpl: fakeSpawn(JSON.stringify({ ok: false, error: "tree too large" })), timeoutMs: 1000 })).rejects.toThrow("tree too large");
    await expect(solveWithAdapter("adapter", {}, { spawnImpl: fakeSpawn("", 3), timeoutMs: 1000 })).rejects.toThrow("exited with 3");
  });
});
