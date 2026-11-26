"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { timed } from "@/lib/timing";
import { isWasmSolverSupported } from "@/lib/wasm-solver/client";
import { MULTIWAY_MAX_PLAYERS } from "@/lib/wasm-solver/multiway-request";
import type { PostflopAdvice } from "@/lib/self-play/postflop-advice";
import type { SolveSpot } from "./advice-runner";

/** After a native failure (busy server, error), skip the server for this long instead of retrying every spot. */
const NATIVE_COOLDOWN_MS = 30_000;
/** Spots waiting to be solved; the oldest are dropped beyond this (their decisions stay ungraded). */
const MAX_QUEUED_SPOTS = 20;
const subscribeNever = () => () => {};
const MULTIWAY_STREETS = ["turn", "river"];

export type AdviceEntry =
  | { status: "done"; advice: PostflopAdvice; method: string; notes: string[]; elapsedMs: number; retryable: boolean }
  | { status: "error"; message: string };

interface Capability { native: boolean; multiwayStreets: string[]; }

/** What the server solver offers; null until the capability check answers. */
function useCapability() {
  const [capability, setCapability] = useState<Capability | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/solver", { signal: controller.signal, cache: "no-store" })
      .then(response => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then(value => {
        const multiway = value?.nativeMultiway;
        // Only the streets the 3-way solver is known to handle; anything else in the reply is ignored.
        const multiwayOk = multiway && typeof multiway.maxPlayers === "number" && Number.isFinite(multiway.maxPlayers) && multiway.maxPlayers >= MULTIWAY_MAX_PLAYERS && Array.isArray(multiway.streets);
        const streets = multiwayOk ? MULTIWAY_STREETS.filter(street => multiway.streets.includes(street)) : [];
        setCapability({ native: value?.nativeJson === true, multiwayStreets: streets });
      })
      .catch(() => { if (!controller.signal.aborted) setCapability({ native: false, multiwayStreets: [] }); });
    return () => controller.abort();
  }, []);
  return capability;
}

interface InFlight { key: string; controller: AbortController; }

/**
 * Runs queued advice jobs one at a time, in the order they were queued, and keeps every answer by key. The current
 * spot is queued automatically; `enqueue` keeps a spot whose decision was already made, so it is graded when solved.
 */
export function useSolverAdvice(current: SolveSpot | null) {
  const capability = useCapability();
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

  // A real unmount (or StrictMode's simulated one) cancels the running job and frees the slot for a remount.
  useEffect(() => () => {
    inFlight.current?.controller.abort();
    inFlight.current = null;
  }, []);

  useEffect(() => {
    if (capability === null || inFlight.current) return;
    const spot = queue.find(item => !entries[item.key]);
    if (!spot) return;
    const job: InFlight = { key: spot.key, controller: new AbortController() };
    inFlight.current = job;
    queueMicrotask(() => setRunning(spot.key));
    const env = { native: capability.native && Date.now() >= nativeCooldownUntil.current, multiwayStreets: capability.multiwayStreets, wasmSupported, signal: job.controller.signal };
    timed(() => spot.run(env))
      .then(({ value, elapsedMs }): AdviceEntry => {
        if (value.nativeFailed) nativeCooldownUntil.current = Date.now() + NATIVE_COOLDOWN_MS;
        return { status: "done", advice: value.advice, method: value.method, notes: value.notes, elapsedMs, retryable: value.retryable === true };
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
  }, [queue, entries, capability, wasmSupported]);

  /** Forgets one answer (e.g. an error) so the spot is solved again. */
  const retry = useCallback((spot: SolveSpot) => {
    setEntries(stored => Object.fromEntries(Object.entries(stored).filter(([key]) => key !== spot.key)));
    enqueue(spot);
  }, [enqueue]);
  /** A new hand: cancels the running job and drops every queued spot and answer. */
  const reset = useCallback(() => {
    inFlight.current?.controller.abort();
    inFlight.current = null;
    setRunning(null);
    setQueue([]);
    setEntries({});
  }, []);
  return { entries, running, queued: queue.filter(item => !entries[item.key]).map(item => item.key), capability, enqueue, retry, reset };
}
