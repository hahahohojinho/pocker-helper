import { describe, expect, it } from "vitest";
import { canonicalFlop, enumerateCanonicalFlops, mapCards } from "./canonical";

describe("canonicalFlop", () => {
  it("maps suit permutations of a board to one class", () => {
    const boards = [["Ks", "7d", "2c"], ["Kh", "7s", "2d"], ["2c", "Kd", "7h"]];
    expect(new Set(boards.map(board => canonicalFlop(board).board)).size).toBe(1);
  });
  it("keeps monotone, two-tone, paired, and trips boards apart", () => {
    const classes = [["Ks", "7s", "2s"], ["Ks", "7s", "2d"], ["Ks", "7d", "2s"], ["Ks", "Kd", "2s"], ["Ks", "Kd", "Kc"], ["Ks", "7d", "2c"]].map(board => canonicalFlop(board).board);
    expect(new Set(classes).size).toBe(classes.length);
  });
  it("maps hero cards with the board's suit map, keeping blockers", () => {
    const { board, suitMap } = canonicalFlop(["Ks", "7d", "2c"]);
    const hero = mapCards(["As", "Kd"], suitMap);
    // The ace keeps the king's suit, the king of the 7's suit.
    expect(hero[0][1]).toBe(board.slice(0, 2)[1]);
    expect(hero[1][1]).toBe(board.slice(2, 4)[1]);
  });
  it("rejects malformed or duplicate boards", () => {
    expect(() => canonicalFlop(["Ks", "Ks", "2c"])).toThrow();
    expect(() => canonicalFlop(["Ks", "7d"])).toThrow();
    expect(() => canonicalFlop(["Kx", "7d", "2c"])).toThrow();
  });
});

describe("enumerateCanonicalFlops", () => {
  it("finds the 1755 strategically distinct flops covering all 22100", () => {
    const flops = enumerateCanonicalFlops();
    expect(flops).toHaveLength(1755);
    expect(flops.reduce((sum, flop) => sum + flop.weight, 0)).toBe(22100);
    expect(flops.every(flop => canonicalFlop([flop.board.slice(0, 2), flop.board.slice(2, 4), flop.board.slice(4, 6)]).board === flop.board)).toBe(true);
  });
});
