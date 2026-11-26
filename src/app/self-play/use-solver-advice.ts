"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { timed } from "@/lib/timing";
import { isWasmSolverSupported, runWasmSolve } from "@/lib/wasm-solver/client";
import { NativeSolverUnavailableError, runNativeSolve } from "@/lib/wasm-solver/native-client";
import { loadIterationCost, recordIterationCost } from "@/lib/wasm-solver/cost-model";
import type { WasmSolveRequest } from "@/lib/wasm-solver/request";
import { parsePostflopAdvice, type PostflopAdvice, type SolveBackend } from "@/lib/self-play/postflop-advice";
import type { PostflopStreet } from "@/lib/self-play/hand-state";

/** Same limit as the postflop panel: a single-threaded browser flop solve can take over a minute. */
const WASM_SOLVE_TIMEOUT_MS = 240_000;
const MIN_COST_SAMPLE_ITERATIONS = 3;
/** After a native failure (busy server, error), skip the server for this long instead of retrying every spot. */
const NATIVE_COOLDOWN_MS = 30_000;
/** Spots waiting to be solved; the oldest are dropped beyond this (their decisions stay ungraded). */
const MAX_QUEUED_SPOTS = 20;
const subscribeNever = () => () => {};
function browserStorage() { try { return window.localStorage; } catch { return undefined; } }

export type AdviceEntry =
  | { status: "done"; advice: PostflopAdvice; backend: SolveBackend; elapsedMs: number }
  | { status: "error"; message: string };

/** A spot to solve: `key` identifies it; `build` makes the request for a backend (null when it cannot be solved). */
export interface SolveSpot { key: string; street: PostflopStreet; build: (backend: SolveBackend, iterationCostNs?: number) => WasmSolveRequest | null; }

/** Whether the server runs the native solver; null until the capability check answers. */
function useNativeAvailable() {
  const [native, setNative] = useState<boolean | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/solver", { signal: controller.signal, cache: "no-store" })
      .then(response => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then(value => setNative(value?.nativeJson === true))
      .catch(() => { if (!controller.signal.aborted) setNative(false); });
    return () => controller.abort();
  }, []);
  return native;
}

async function solveOnce(spot: SolveSpot, native: boolean, wasmSupported: boolean, signal: AbortSignal): Promise<{ raw: string; backend: SolveBackend; nativeFailed: boolean }> {
  if (native) {
    const request = spot.build("native");
    if (!request) throw new Error("이 스팟은 헤즈업 솔버로 풀 수 없습니다.");
    try { return { raw: await runNativeSolve(request, { signal }), backend: "native", nativeFailed: false }; }
    catch (error) {
      // Busy (another solve holds the server slot), unavailable or failed natively: the browser can still answer.
      if (signal.aborted || !wasmSupported) throw error;
      if (!(error instanceof NativeSolverUnavailableError)) console.warn("Native solve failed; using the browser solver", error);
    }
  }
  if (!wasmSupported) throw new Error("이 브라우저는 WebAssembly 솔버를 지원하지 않습니다.");
  const request = spot.build("wasm", loadIterationCost(browserStorage(), spot.street));
  if (!request) throw new Error("이 스팟은 헤즈업 솔버로 풀 수 없습니다.");
  const { value: raw, elapsedMs } = await timed(() => runWasmSolve(request, { timeoutMs: WASM_SOLVE_TIMEOUT_MS, signal }));
  // Budget-limited solves teach the cost model this machine's speed, as in the postflop panel.
  try {
    const { workUnits, iterations, stoppedBy } = JSON.parse(raw) as { workUnits?: number; iterations?: number; stoppedBy?: string };
    if (workUnits && iterations && iterations > MIN_COST_SAMPLE_ITERATIONS && stoppedBy === "deadline") recordIterationCost(browserStorage(), spot.street, { elapsedMs, workUnits, iterations });
  } catch { /* Cost learning is best effort; a malformed answer is reported when it is parsed as advice. */ }
  return { raw, backend: "wasm", nativeFailed: native };
}

interface InFlight { key: string; controller: AbortController; }

/**
 * Solves queued spots one at a time, in the order they were queued, and keeps every answer by key. The current spot
 * is queued automatically; `enqueue` keeps a spot whose decision was already made, so it is graded when solved.
 */
export function useSolverAdvice(current: SolveSpot | null) {
  const native = useNativeAvailable();
  const wasmSupported = useSyncExternalStore(subscribeNever, isWasmSolverSupported, () => false);
  const [entries, setEntries] = useState<Record<string, AdviceEntry>>({});
  const [queue, setQueue] = useState<SolveSpot[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  // Synchronous guard: React may run an effect twice before state updates land (StrictMode, fast re-renders).
  const inFlight = useRef<InFlight | null>(null);
  const nativeCooldownUntil = useRef(0);

  const enqueue = useCallback((spot: SolveSpot) => {
    setQueue(pending => pending.some(item => item.key === spot.key) ? pending : [...pending, spot].slice(-MAX_QUEUED_SPOTS));
  }, []);
  useEffect(() => { if (current) queueMicrotask(() => enqueue(current)); }, [current, enqueue]);

  // A real unmount (or StrictMode's simulated one) cancels the running solve and frees the slot for a remount.
  useEffect(() => () => {
    inFlight.current?.controller.abort();
    inFlight.current = null;
  }, []);

  useEffect(() => {
    if (native === null || inFlight.current) return;
    const spot = queue.find(item => !entries[item.key]);
    if (!spot) return;
    const job: InFlight = { key: spot.key, controller: new AbortController() };
    inFlight.current = job;
    queueMicrotask(() => setRunning(spot.key));
    const useNative = native && Date.now() >= nativeCooldownUntil.current;
    timed(() => solveOnce(spot, useNative, wasmSupported, job.controller.signal))
      .then(({ value, elapsedMs }): AdviceEntry => {
        if (value.nativeFailed) nativeCooldownUntil.current = Date.now() + NATIVE_COOLDOWN_MS;
        return { status: "done", advice: parsePostflopAdvice(value.raw), backend: value.backend, elapsedMs };
      })
      .catch((error: unknown): AdviceEntry => ({ status: "error", message: error instanceof Error ? error.message : "솔버 실행에 실패했습니다." }))
      .then(entry => {
        // A cancelled job (unmount, reset) stores nothing and must not release a newer job's slot.
        if (inFlight.current !== job) return;
        inFlight.current = null;
        setEntries(stored => ({ ...stored, [spot.key]: entry }));
        setQueue(pending => pending.filter(item => item.key !== spot.key));
        setRunning(null);
      });
  }, [queue, entries, native, wasmSupported]);

  /** Forgets one answer (e.g. an error) so the spot is solved again. */
  const retry = useCallback((spot: SolveSpot) => {
    setEntries(stored => Object.fromEntries(Object.entries(stored).filter(([key]) => key !== spot.key)));
    enqueue(spot);
  }, [enqueue]);
  /** A new hand: cancels the running solve and drops every queued spot and answer. */
  const reset = useCallback(() => {
    inFlight.current?.controller.abort();
    inFlight.current = null;
    setRunning(null);
    setQueue([]);
    setEntries({});
  }, []);
  return { entries, running, queued: queue.filter(item => !entries[item.key]).map(item => item.key), nativeAvailable: native, enqueue, retry, reset };
}
