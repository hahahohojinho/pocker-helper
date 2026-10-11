import { describe, expect, it } from "vitest";
import { MAX_SOLUTION_CHARS, parseFlopIndex, parseFlopSolution } from "./format";
import { FIXTURE_BOARD, fixtureIndex, fixtureScenario, fixtureSolution } from "./fixture";

const parse = (overrides: Record<string, unknown> = {}) => parseFlopSolution(fixtureSolution(overrides), fixtureScenario.id, FIXTURE_BOARD);
const rootNode = () => JSON.parse(fixtureSolution()).nodes[""];
const withRoot = (patch: Record<string, unknown>) => ({ "": { ...rootNode(), ...patch } });

describe("parseFlopIndex", () => {
  it("accepts a valid index", () => {
    expect(parseFlopIndex(fixtureIndex()).scenarios[0]).toMatchObject({ id: fixtureScenario.id, stacks: [9750, 9750] });
  });
  it("rejects a wrong contract, a path-like id, a bad flop, and a zero pot", () => {
    expect(() => parseFlopIndex(JSON.stringify({ contract: "x", scenarios: [] }))).toThrow();
    const index = (patch: Record<string, unknown>) => JSON.stringify({ ...JSON.parse(fixtureIndex()), scenarios: [{ ...fixtureScenario, ...patch }] });
    expect(() => parseFlopIndex(index({ id: "../etc" }))).toThrow();
    expect(() => parseFlopIndex(index({ flops: ["Ks7d"] }))).toThrow();
    expect(() => parseFlopIndex(index({ pot: 0 }))).toThrow();
    expect(() => parseFlopIndex(index({ specHash: "x" }))).toThrow();
  });
});

describe("parseFlopSolution", () => {
  it("accepts a valid solution", () => {
    const solution = parse();
    expect(solution.combos.oop).toEqual(["AhAs", "7h2d"]);
    expect(solution.nodes["b1/2"]?.unreached).toEqual([1]);
  });
  it("rejects a file for another board or scenario", () => {
    expect(() => parseFlopSolution(fixtureSolution(), fixtureScenario.id, "Ks7d3c")).toThrow();
    expect(() => parseFlopSolution(fixtureSolution(), "other", FIXTURE_BOARD)).toThrow();
  });
  it("rejects frequencies that do not sum to 1000, wrong lengths, and non-integer values", () => {
    expect(() => parse({ nodes: withRoot({ freq: [600, 399, 0, 1000] }) })).toThrow(/freq total/);
    expect(() => parse({ nodes: withRoot({ freq: [600, 400] }) })).toThrow(/freq/);
    expect(() => parse({ nodes: withRoot({ ev: [500, 520, 100, 1.5] }) })).toThrow(/ev/);
    expect(() => parse({ build: { iterations: 1, exploitability: null, elapsedMs: 1 } })).toThrow();
  });
  it("rejects combos that touch the board, repeat, or are malformed", () => {
    expect(() => parse({ combos: { oop: "Kc7h2s3s", ip: "KhKdQhQs" } })).toThrow();
    expect(() => parse({ combos: { oop: "AhAsAhAs", ip: "KhKdQhQs" } })).toThrow();
    expect(() => parse({ combos: { oop: "AhA", ip: "KhKdQhQs" } })).toThrow();
  });
  it("rejects unknown node keys and oversized files", () => {
    expect(() => parse({ nodes: { "x,x,x": rootNode() } })).toThrow();
    expect(() => parseFlopSolution(" ".repeat(MAX_SOLUTION_CHARS + 1), fixtureScenario.id, FIXTURE_BOARD)).toThrow(/too large/);
  });
});
