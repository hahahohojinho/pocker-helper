import { describe, expect, it } from "vitest";
import { callerSubsets, defaultMultiwayFolds, multiwayBetEv, planSubsets, type SubsetEquities } from "./multiway-ev";
import { estimateSubsetEquities } from "./called-equity";

const equities = (entries: [string, number][], everyone: number | null = null): SubsetEquities => ({ byKey: new Map(entries), everyone });

describe("callerSubsets", () => {
  it("lists every combination with probabilities summing to one, most likely first", () => {
    const subsets = callerSubsets([{ call: 0.5, fold: 0.5 }, { call: 0.4, fold: 0.6 }, { call: 0.1, fold: 0.9 }]);
    expect(subsets).toHaveLength(8);
    expect(subsets.reduce((sum, subset) => sum + subset.probability, 0)).toBeCloseTo(1, 10);
    expect(subsets.map(subset => subset.probability)).toEqual([...subsets.map(subset => subset.probability)].sort((a, b) => b - a));
  });
  it("drops impossible combinations", () => {
    expect(callerSubsets([{ call: 1, fold: 0 }, { call: 0.5, fold: 0.5 }]).map(subset => subset.members)).toEqual([[0], [0, 1]]);
  });
});

describe("planSubsets", () => {
  it("bounds exact subsets for seven opponents and keeps all probability mass", () => {
    const plan = planSubsets(callerSubsets(Array.from({ length: 7 }, () => ({ call: 0.5, fold: 0.5 }))));
    expect(plan.exact.length).toBeLessThanOrEqual(8);
    expect(plan.rest.length).toBeGreaterThan(0);
    const mass = plan.foldAll + [...plan.exact, ...plan.rest].reduce((sum, subset) => sum + subset.probability, 0);
    expect(mass).toBeCloseTo(1, 10);
  });
  it("is exact for one opponent", () => {
    expect(planSubsets(callerSubsets([{ call: 0.6, fold: 0.4 }]))).toMatchObject({ exact: [{ members: [0] }], rest: [], foldAll: 0.4 });
  });
});

describe("defaultMultiwayFolds", () => {
  it("splits the break-even fold rate so that everyone folds exactly that often", () => {
    const folds = defaultMultiwayFolds(1 / 3, [true, true]);
    expect(folds[0]).toBeCloseTo(Math.sqrt(1 / 3), 10);
    expect(folds[0] * folds[1]).toBeCloseTo(1 / 3, 10);
  });
  it("gives an all-in opponent no fold and keeps one opponent at the break-even rate", () => {
    expect(defaultMultiwayFolds(0.4, [true, false])).toEqual([0.4, 0]);
    expect(defaultMultiwayFolds(0.25, [true])).toEqual([0.25]);
  });
});

describe("multiwayBetEv", () => {
  it("matches a hand computation for two opponents", () => {
    // Callers: none 0.3 (win 10), {0} 0.3, {1} 0.2 (pot 20), both 0.2 (pot 25).
    const result = multiwayBetEv({ pot: 10, heroRisk: 5, villainCall: 5, folds: [0.5, 0.6], equities: equities([["0", 50], ["1", 40], ["0,1", 30]]) });
    expect(result.ev).toBeCloseTo(3 + 1.5 + 0.6 + 0.5, 10);
    expect(result.foldAll).toBeCloseTo(0.3, 10);
    expect(result.expectedCallers).toBeCloseTo(0.9, 10);
    expect(result.approximate).toBe(false);
  });
  it("makes a pure bluff break even at the default folds for any number of opponents", () => {
    for (let opponents = 1; opponents <= 7; opponents++) {
      const breakEven = 7 / 17;
      const folds = defaultMultiwayFolds(breakEven, Array(opponents).fill(true));
      const result = multiwayBetEv({ pot: 10, heroRisk: 7, villainCall: 7, folds, equities: equities([], 0) });
      expect(result.ev).toBeCloseTo(0, 8);
    }
  });
  it("returns the hero's uncalled excess against a short caller", () => {
    // The caller can add only 2: hero puts in 2, the pot is 14.
    const result = multiwayBetEv({ pot: 10, heroRisk: 5, villainCall: 5, folds: [0], callCaps: [2], equities: equities([["0", 50]]) });
    expect(result.ev).toBeCloseTo(0.5 * 14 - 2, 10);
  });
  it("only calls when betting into an all-in opponent", () => {
    // Hero faces a 4 all-in (pot 14) and raises to 10; nobody can call the extra 6.
    const result = multiwayBetEv({ pot: 14, heroRisk: 10, villainCall: 6, folds: [0], callCaps: [0], equities: equities([["0", 50]]) });
    expect(result.ev).toBeCloseTo(0.5 * 18 - 4, 10);
  });
  it("adds what an opponent still owes to the current bet when they call a raise", () => {
    // A bet 4, B has 0 in; hero raises to 12. B calling pays 4 + 8, A pays 8: pot 10 + 12 + 12 + 8.
    const result = multiwayBetEv({ pot: 14, heroRisk: 12, villainCall: 8, folds: [0, 0], owed: [0, 4], equities: equities([["0,1", 50]]) });
    expect(result.ev).toBeCloseTo(0.5 * (14 + 12 + 8 + 12) - 12, 10);
  });
  it("rejects per-opponent arrays of the wrong length", () => {
    expect(() => multiwayBetEv({ pot: 10, heroRisk: 5, villainCall: 5, folds: [0.5, 0.5], callCaps: [1], equities: equities([], 40) })).toThrow(RangeError);
  });
  it("uses the everyone estimate for unlikely subsets and flags it", () => {
    const folds = Array(5).fill(0.5);
    const plan = planSubsets(callerSubsets(folds.map(fold => ({ call: 1 - fold, fold }))));
    const byKey = plan.exact.map(subset => [subset.members.join(","), 40] as [string, number]);
    expect(multiwayBetEv({ pot: 10, heroRisk: 5, villainCall: 5, folds, equities: equities(byKey, 20) }).approximate).toBe(true);
    expect(() => multiwayBetEv({ pot: 10, heroRisk: 5, villainCall: 5, folds, equities: equities(byKey) })).toThrow();
  });
});

describe("estimateSubsetEquities", () => {
  const board = ["Ks", "7h", "2c"], hero = ["8c", "8d"];
  const range = "AA,KK,QQ,JJ,TT,99,AKs,AQs,KQs,QJs,JTs,T9s,98s,AKo,AQo,KQo";
  it("calls the equity function once per exact subset plus once for the rest", () => {
    let calls = 0;
    const counting = () => { calls += 1; return 30; };
    estimateSubsetEquities(hero, board, [range], [0.4], 1000, counting);
    expect(calls).toBe(1);
    calls = 0;
    const result = estimateSubsetEquities(hero, board, Array(7).fill(range), Array(7).fill(0.5), 1000, counting)!;
    expect(calls).toBeLessThanOrEqual(9);
    expect(result.everyone).toBe(30);
  });
  it("skips an opponent who always folds", () => {
    const result = estimateSubsetEquities(hero, board, [range, range], [1, 0.5], 1000, ranges => ranges.length * 10)!;
    expect([...result.byKey.keys()]).toEqual(["1"]);
  });
  it("returns null before the flop", () => {
    expect(estimateSubsetEquities(hero, [], [range], [0.4], 1000)).toBeNull();
  });
  it("stays fast for seven wide ranges with the real equity engine", () => {
    const start = performance.now();
    const wide = "AA,KK,QQ,JJ,TT,99,88,77,66,55,44,33,22,AKs,AQs,AJs,ATs,A9s,A8s,A7s,A6s,A5s,A4s,A3s,A2s,KQs,KJs,KTs,QJs,QTs,JTs,T9s,98s,87s,76s,65s,54s,AKo,AQo,AJo,KQo";
    const result = estimateSubsetEquities(hero, board, Array(7).fill(wide), defaultMultiwayFolds(1 / 3, Array(7).fill(true)), 5000)!;
    expect(performance.now() - start).toBeLessThan(2000);
    expect(result.byKey.size).toBeGreaterThan(0);
  });
});
