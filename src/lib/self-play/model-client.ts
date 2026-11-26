import type { HandTurn, SelfPlayHand } from "./hand-state";
import { modelAdvice } from "./model-advice";
import type { PostflopAdvice } from "./postflop-advice";

type PostflopTurn = Extract<HandTurn, { kind: "postflop" }>;
export interface ModelWorkerRequest { id: number; hand: SelfPlayHand; turn: PostflopTurn; hole: readonly [string, string]; }
export type ModelWorkerResponse = { id: number; ok: true; advice: PostflopAdvice } | { id: number; ok: false; error: string };

let nextId = 1;

/**
 * Model EV in a worker (the hand, turn context Maps/Sets and cards are structured-cloned). Aborting terminates the
 * worker, which stops the calculation. Without Worker support (tests, old browsers) it runs inline.
 */
export function runModelAdvice(hand: SelfPlayHand, turn: PostflopTurn, hole: readonly [string, string], signal: AbortSignal): Promise<PostflopAdvice> {
  if (typeof Worker !== "function") return Promise.resolve(modelAdvice(hand, turn, hole));
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("Model EV calculation was cancelled.")); return; }
    const worker = new Worker(new URL("../../workers/self-play-model.worker.ts", import.meta.url), { type: "module" });
    const id = nextId++;
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true; signal.removeEventListener("abort", onAbort); worker.terminate(); outcome();
    };
    const onAbort = () => finish(() => reject(new Error("Model EV calculation was cancelled.")));
    signal.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<ModelWorkerResponse>) => {
      const response = event.data;
      if (response.id !== id) return;
      finish(() => response.ok ? resolve(response.advice) : reject(new Error(response.error)));
    };
    worker.onerror = (event: ErrorEvent) => finish(() => reject(new Error(event.message || "Model EV worker failed.")));
    worker.onmessageerror = () => finish(() => reject(new Error("Model EV response could not be read.")));
    // A value that cannot be cloned throws here; the worker must still be terminated.
    try { worker.postMessage({ id, hand, turn, hole } satisfies ModelWorkerRequest); }
    catch (error) { finish(() => reject(error instanceof Error ? error : new Error("Model EV request failed."))); }
  });
}
