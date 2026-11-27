import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalFlop, mapCards } from "@/lib/flop-library/canonical";
import { INDEX_CONTRACT, SOLUTION_CONTRACT } from "@/lib/flop-library/format";
import { resetFlopLibraryCache } from "@/lib/flop-library/loader";
import { applyAction, createHand, handTurn, type SelfPlayHand } from "@/lib/self-play/hand-state";
import { gradePostflop, headsUpRequest } from "@/lib/self-play/postflop-advice";
import { spotFor, type SolveEnv } from "./advice-runner";

type Turn = Extract<ReturnType<typeof handTurn>, { kind: "postflop" }>;
const SPEC_HASH = "0123456789abcdef";

// UTG..CO fold, BTN opens 2.5, SB folds, BB calls: BB acts first on the flop.
function headsUpFlop(): { hand: SelfPlayHand; turn: Turn } {
  const steps: [string, number][] = [["fold", 0], ["fold", 0], ["fold", 0], ["open", 2.5], ["fold", 0], ["call", 2.5]];
  const hand = steps.reduce((current, [type, amount]) => {
    const result = applyAction(current, type as never, amount);
    if (!result.ok) throw new Error(result.message);
    return result.hand;
  }, createHand({ seed: 21, handNo: 0, stacks: Array(6).fill(100) }));
  const turn = handTurn(hand);
  if (turn.kind !== "postflop") throw new Error("expected a flop turn");
  return { hand, turn };
}

/** A one-board library built from the self-play request itself, so it answers exactly that spot. */
function libraryFor(hand: SelfPlayHand, turn: Turn) {
  const hole = hand.holeCards[turn.seat]!;
  const request = headsUpRequest(hand, turn, hole, "native")!;
  const { board, suitMap } = canonicalFlop(hand.board.slice(0, 3));
  const hero = mapCards([...hole], suitMap).join("");
  const scenario = { id: "6max-100bb-srp-btn-bb", label: "BTN vs BB SRP 100bb", oop: "BB", ip: "BTN", pot: request.pot, stacks: request.stacks,
    betSizes: request.betSizes, maxRaises: request.maxRaises, oopRange: request.oopRange, ipRange: request.ipRange, flops: [board], generatedAt: "2026-10-17", specHash: SPEC_HASH };
  const solution = { contract: SOLUTION_CONTRACT, scenario: scenario.id, board, build: { iterations: 40, exploitability: 0.12, elapsedMs: 30000, specHash: SPEC_HASH },
    combos: { oop: hero, ip: "AsAh" },
    nodes: { "": { player: "oop", actions: [{ category: "check", label: "check" }, { category: "bet", label: "bet 1/2" }], freq: [700, 300], ev: [210, 190], unreached: [] } } };
  return vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(String(url).endsWith("index.json") ? { contract: INDEX_CONTRACT, scenarios: [scenario] } : solution),
    { status: 200, headers: { "content-type": "application/json" } }));
}

const env = (patch: Partial<SolveEnv> = {}): SolveEnv => ({ native: false, multiwayStreets: [], wasmSupported: false, signal: new AbortController().signal, ...patch });

afterEach(() => {
  resetFlopLibraryCache();
  vi.unstubAllGlobals();
});

describe("self-play flop advice from the library", () => {
  it("answers a stored heads-up flop without any live solver and grades the stored size", async () => {
    const { hand, turn } = headsUpFlop();
    vi.stubGlobal("fetch", libraryFor(hand, turn));
    const solved = await spotFor(hand, turn, hand.holeCards[turn.seat]!, "k").run(env());
    expect(solved.method).toBe("FLOP LIBRARY");
    expect(solved.notes.join(" ")).toContain("체크다운");
    expect(solved.advice.result).toMatchObject({ source: "flop-library", bestAction: "check", exploitability: 0.12 });
    // A 2.75bb bet is half the 5.5bb pot: graded against the stored "bet 1/2" (EV 1.9 vs check 2.1).
    const grade = gradePostflop(solved.advice, "bet", 2.75, turn.context, turn.seat);
    expect(grade).toMatchObject({ chosenLabel: "bet 1/2", bestLabel: "check", sizeApprox: false });
    expect(grade!.evLoss).toBeCloseTo(0.2, 10);
  });
  it("rejects a cancelled job before looking anything up", async () => {
    const { hand, turn } = headsUpFlop();
    const fetchImpl = libraryFor(hand, turn);
    vi.stubGlobal("fetch", fetchImpl);
    const controller = new AbortController();
    controller.abort();
    await expect(spotFor(hand, turn, hand.holeCards[turn.seat]!, "k").run(env({ signal: controller.signal }))).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("falls back to the live path when the library has no file for the spot", async () => {
    const { hand, turn } = headsUpFlop();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    // No native and no WebAssembly here, so the live path is the model.
    const run = spotFor(hand, turn, hand.holeCards[turn.seat]!, "k").run(env());
    await expect(run).resolves.toMatchObject({ method: "MODEL EV" });
  });
});
