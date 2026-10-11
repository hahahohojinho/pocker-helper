import { INDEX_CONTRACT, SOLUTION_CONTRACT } from "./format";

/** Test data: a tiny scenario on the canonical K72 rainbow flop (canonical form Kc7d2h). Not used by the app. */
export const FIXTURE_BOARD = "Kc7d2h";
export const fixtureScenario = {
  id: "6max-100bb-srp-btn-bb", label: "BTN vs BB SRP 100bb", oop: "BB", ip: "BTN", pot: 550, stacks: [9750, 9750],
  betSizes: [[[1, 2]], [[3, 5]]], maxRaises: 2, oopRange: "AA,KK,72o", ipRange: "AA,KK,QQ", flops: [FIXTURE_BOARD], generatedAt: "2026-10-11", specHash: "0123456789abcdef",
};
export const fixtureIndex = () => JSON.stringify({ contract: INDEX_CONTRACT, scenarios: [fixtureScenario] });

/** OOP root: AhAs checks 60% / bets 40%; IP vs bet: KhKd folds 10%, calls 50%, raises 40% (two raise sizes). */
export function fixtureSolution(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    contract: SOLUTION_CONTRACT, scenario: fixtureScenario.id, board: FIXTURE_BOARD,
    build: { iterations: 61, exploitability: 0.21, elapsedMs: 15120, specHash: "0123456789abcdef" },
    combos: { oop: "AhAs7h2d", ip: "KhKdQhQs" },
    nodes: {
      "": { player: "oop", actions: [{ category: "check", label: "Check" }, { category: "bet", label: "Bet 1/2" }], freq: [600, 400, 0, 1000], ev: [500, 520, 100, 150], unreached: [] },
      "b1/2": {
        player: "ip",
        actions: [{ category: "fold", label: "Fold" }, { category: "call", label: "Call" }, { category: "raise", label: "Raise 3/5" }, { category: "raise", label: "AllIn" }],
        freq: [100, 500, 300, 100, 1000, 0, 0, 0], ev: [0, 300, 400, 200, 0, -50, -80, -90], unreached: [1],
      },
    },
    ...overrides,
  });
}
