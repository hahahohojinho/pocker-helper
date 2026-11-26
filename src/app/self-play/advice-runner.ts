import { timed } from "@/lib/timing";
import { runWasmSolve } from "@/lib/wasm-solver/client";
import { isTransientNativeFailure, runNativeMultiwaySolve, runNativeSolve } from "@/lib/wasm-solver/native-client";
import { loadIterationCost, recordIterationCost } from "@/lib/wasm-solver/cost-model";
import type { HandTurn, PostflopStreet, SelfPlayHand } from "@/lib/self-play/hand-state";
import { checkedDown, headsUpRequest, parsePostflopAdvice, streetStartSeats, type PostflopAdvice } from "@/lib/self-play/postflop-advice";
import { multiwayRequest } from "@/lib/self-play/model-advice";
import { runModelAdvice } from "@/lib/self-play/model-client";

type PostflopTurn = Extract<HandTurn, { kind: "postflop" }>;
/** Same limit as the postflop panel: a single-threaded browser flop solve can take over a minute. */
const WASM_SOLVE_TIMEOUT_MS = 240_000;
const MIN_COST_SAMPLE_ITERATIONS = 3;
function browserStorage() { try { return window.localStorage; } catch { return undefined; } }

/** What the page can use right now; `native` is false while the server solver is cooling down after a failure. */
export interface SolveEnv { native: boolean; multiwayStreets: readonly string[]; wasmSupported: boolean; signal: AbortSignal; }
/** `retryable`: a stand-in answer (the model) given only because a solver was unavailable; worth solving again later. */
export interface SolvedAdvice { advice: PostflopAdvice; method: string; notes: string[]; nativeFailed: boolean; retryable?: boolean; }
export interface SolveSpot { key: string; street: PostflopStreet; run: (env: SolveEnv) => Promise<SolvedAdvice>; }

const nativeFallbackNote = "네이티브 솔버가 응답하지 않아 대체 방법으로 계산했습니다.";

async function headsUp(hand: SelfPlayHand, turn: PostflopTurn, hole: readonly [string, string], env: SolveEnv): Promise<SolvedAdvice> {
  let nativeFailed = false;
  if (env.native) {
    const request = headsUpRequest(hand, turn, hole, "native");
    if (!request) throw new Error("이 스팟은 헤즈업 솔버로 풀 수 없습니다.");
    try {
      const advice = parsePostflopAdvice(await runNativeSolve(request, { signal: env.signal }));
      return { advice, method: "HU DCFR NATIVE", notes: checkedDown("native", turn) ? [CHECKDOWN_NOTE] : [], nativeFailed };
    } catch (error) {
      if (env.signal.aborted) throw error;
      console.warn("Native solve failed; using a fallback", error);
      // Only server trouble pauses the native path; a rejected request says nothing about the next spot.
      nativeFailed = isTransientNativeFailure(error);
      // Busy, unavailable or failed natively: the browser solver answers, or the model when there is none.
      if (!env.wasmSupported) return { ...(await model(hand, turn, hole, env, [nativeFallbackNote], nativeFailed)), retryable: nativeFailed };
    }
  }
  if (!env.wasmSupported) throw new Error("이 브라우저는 WebAssembly 솔버를 지원하지 않습니다.");
  const request = headsUpRequest(hand, turn, hole, "wasm", loadIterationCost(browserStorage(), turn.street));
  if (!request) throw new Error("이 스팟은 헤즈업 솔버로 풀 수 없습니다.");
  const { value: raw, elapsedMs } = await timed(() => runWasmSolve(request, { timeoutMs: WASM_SOLVE_TIMEOUT_MS, signal: env.signal }));
  try {
    // Budget-limited solves teach the cost model this machine's speed, as in the postflop panel.
    const { workUnits, iterations, stoppedBy } = JSON.parse(raw) as { workUnits?: number; iterations?: number; stoppedBy?: string };
    if (workUnits && iterations && iterations > MIN_COST_SAMPLE_ITERATIONS && stoppedBy === "deadline") recordIterationCost(browserStorage(), turn.street, { elapsedMs, workUnits, iterations });
  } catch { /* Cost learning is best effort; a malformed answer is reported when it is parsed as advice. */ }
  const notes = [...(checkedDown("wasm", turn) ? [CHECKDOWN_NOTE] : []), ...(nativeFailed ? [nativeFallbackNote] : [])];
  return { advice: parsePostflopAdvice(raw), method: "HU DCFR WASM", notes, nativeFailed };
}

const CHECKDOWN_NOTE = "이후 스트리트 체크다운 근사: 다음 스트리트 베팅 없이 계산된 트리입니다.";
async function model(hand: SelfPlayHand, turn: PostflopTurn, hole: readonly [string, string], env: SolveEnv, notes: string[], nativeFailed: boolean): Promise<SolvedAdvice> {
  return { advice: await runModelAdvice(hand, turn, hole, env.signal), method: "MODEL EV", notes, nativeFailed };
}

async function threeWay(hand: SelfPlayHand, turn: PostflopTurn, hole: readonly [string, string], env: SolveEnv): Promise<SolvedAdvice> {
  try {
    // Building the request can throw too (e.g. a raise below the solver tree's minimum); the model still answers.
    const request = multiwayRequest(hand, turn, hole);
    if (!request) return model(hand, turn, hole, env, ["3인이지만 베팅할 수 있는 좌석이 하나뿐이라 솔버 대신 모델로 계산했습니다."], false);
    const advice = parsePostflopAdvice(await runNativeMultiwaySolve(request, { signal: env.signal }));
    const notes = advice.result.riverModel === "checkdown" ? ["리버 체크다운 근사: 3인 턴은 리버 베팅 없이 계산합니다."] : [];
    return { advice, method: "3-WAY CFR", notes: [...notes, "3인 CFR은 내쉬 균형을 보장하지 않습니다 (최대 BR gain으로 수렴 표시)."], nativeFailed: false };
  } catch (error) {
    if (env.signal.aborted) throw error;
    console.warn("3-way solve failed; using the model", error);
    // Only a failure that may pass (busy or down server) is worth re-solving; a rejected request fails the same way.
    const transient = isTransientNativeFailure(error);
    return { ...(await model(hand, turn, hole, env, [nativeFallbackNote], transient)), retryable: transient };
  }
}

/**
 * The advice job for the acting seat: heads-up spots use DCFR, 3-way turns and rivers the native 3-way solver when the
 * server offers it, everything else the one-street model. Only the acting seat's cards are an input.
 */
export function spotFor(hand: SelfPlayHand, turn: PostflopTurn, hole: readonly [string, string], key: string): SolveSpot {
  const players = streetStartSeats(hand, turn.street).length;
  const run = async (env: SolveEnv): Promise<SolvedAdvice> => {
    // Heads-up without any DCFR backend (no native, no WebAssembly) falls back to the model too.
    if (players === 2 && (env.native || env.wasmSupported)) return headsUp(hand, turn, hole, env);
    const threeWaySpot = players === 3 && env.multiwayStreets.includes(turn.street);
    if (threeWaySpot && env.native) return threeWay(hand, turn, hole, env);
    // A 3-way spot the server solves, skipped only while the native solver cools down: say so and allow a re-solve.
    if (threeWaySpot) return { ...(await model(hand, turn, hole, env, ["네이티브 솔버가 잠시 쉬는 중이라 모델로 계산했습니다."], false)), retryable: true };
    return model(hand, turn, hole, env, [], false);
  };
  return { key, street: turn.street, run };
}
