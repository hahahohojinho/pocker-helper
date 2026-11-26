/// <reference lib="webworker" />
import { modelAdvice } from "../lib/self-play/model-advice";
import type { ModelWorkerRequest, ModelWorkerResponse } from "../lib/self-play/model-client";

// The one-street model runs Monte Carlo equity for every bet size; off the main thread the table stays responsive.
self.onmessage = (event: MessageEvent<ModelWorkerRequest>) => {
  const { id, hand, turn, hole } = event.data;
  let response: ModelWorkerResponse;
  try {
    response = { id, ok: true, advice: modelAdvice(hand, turn, hole) };
  } catch (error) {
    response = { id, ok: false, error: error instanceof Error ? error.message : "Model EV calculation failed." };
  }
  self.postMessage(response);
};
