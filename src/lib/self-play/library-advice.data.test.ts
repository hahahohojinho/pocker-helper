import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installPreflopPack, parsePreflopPack } from "../preflop-packs";
import { matchFlopLibrary } from "../flop-library/lookup";
import type { FlopIndex } from "../flop-library/format";
import type { PlayerActionType } from "../game-state";
import type { PostflopActionType } from "../postflop-machine";
import { applyAction, createHand, handTurn, type SelfPlayHand } from "./hand-state";
import { headsUpRequest } from "./postflop-advice";

const packPath = path.join(process.cwd(), "public", "data", "preflop", "6max-100bb.json");
const manifestPath = path.join(process.cwd(), "src", "data", "flop-library-manifest.json");

function play(hand: SelfPlayHand, steps: [PlayerActionType | PostflopActionType, number][]) {
  return steps.reduce((current, [type, amount]) => {
    const result = applyAction(current, type, amount);
    if (!result.ok) throw new Error(`${type} ${amount}: ${result.message}`);
    return result.hand;
  }, hand);
}

/** The committed manifest as an index listing every flop (the matcher does not read the spec hash). */
function manifestIndex(): FlopIndex {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { scenarios: FlopIndex["scenarios"]; flops: { board: string }[] };
  return { scenarios: manifest.scenarios.map(scenario => ({ ...scenario, specHash: "0000000000000000", flops: manifest.flops.map(flop => flop.board) })) };
}

// Self-play builds its flop request like the postflop panel, so a library spot must match the library's scenario.
describe.skipIf(!existsSync(packPath) || !existsSync(manifestPath))("self-play flop requests against the library manifest", () => {
  const cases: { name: string; steps: [PlayerActionType | PostflopActionType, number][]; scenario: string }[] = [
    { name: "BTN open, BB call", steps: [["fold", 0], ["fold", 0], ["fold", 0], ["open", 2.5], ["fold", 0], ["call", 2.5]], scenario: "6max-100bb-srp-btn-bb" },
    { name: "CO open, BTN call", steps: [["fold", 0], ["fold", 0], ["open", 2.5], ["call", 2.5], ["fold", 0], ["fold", 0]], scenario: "6max-100bb-srp-co-btn" },
    { name: "BTN open, BB 3-bet, BTN call", steps: [["fold", 0], ["fold", 0], ["fold", 0], ["open", 2.5], ["fold", 0], ["3bet", 9], ["call", 9]], scenario: "6max-100bb-3bp-btn-bb" },
  ];
  for (const { name, steps, scenario } of cases) {
    it(`${name} matches ${scenario}`, () => {
      installPreflopPack(parsePreflopPack(readFileSync(packPath, "utf8")));
      const index = manifestIndex();
      const seeds = [3, 21, 77];
      const hits = seeds.filter(seed => {
        const hand = play(createHand({ seed, handNo: 0, stacks: Array(6).fill(100) }), steps);
        const turn = handTurn(hand);
        if (turn.kind !== "postflop") throw new Error("expected a flop turn");
        const match = matchFlopLibrary(index, headsUpRequest(hand, turn, hand.holeCards[turn.seat]!, "native")!);
        // A dealt hand outside the acting seat's range is added to it, which is a different spot: only that may miss.
        if ("miss" in match) expect(match.miss).toBe("scenario");
        else expect(match.scenario.id).toBe(scenario);
        return !("miss" in match);
      });
      // Measured 2026-11-27: BTN vs BB 1 of 3 seeds (two BB hands outside the defend range), the others 3 of 3.
      expect(hits.length).toBeGreaterThan(0);
    });
  }
});
