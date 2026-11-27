import type { WasmSolveRequest } from "../wasm-solver/request";
import { loadFlopIndex, loadFlopSolution } from "./loader";
import { answerFromSolution, matchFlopLibrary, type FlopLibraryMiss, type StackApproximation } from "./lookup";

/** `raw` is solver JSON in the live solver's shape (strategy, details, exploitability). */
export type FlopLibraryAnswer =
  | { raw: string; scenarioLabel: string; generatedAt: string; stackApprox?: StackApproximation }
  | { miss: FlopLibraryMiss }
  | { unavailable: true };

/** Answers a heads-up flop request from the locally generated library; "unavailable" when no library exists. */
export async function queryFlopLibrary(request: WasmSolveRequest, fetchImpl: typeof fetch = fetch): Promise<FlopLibraryAnswer> {
  const index = await loadFlopIndex(fetchImpl);
  if (!index) return { unavailable: true };
  const match = matchFlopLibrary(index, request);
  if ("miss" in match) return { miss: match.miss };
  const solution = await loadFlopSolution(match.scenario.id, match.board, fetchImpl);
  if (!solution) return { miss: "board" };
  const raw = answerFromSolution(solution, match);
  if (typeof raw !== "string") return raw;
  return { raw, scenarioLabel: match.scenario.label, generatedAt: match.scenario.generatedAt, ...(match.stackApprox ? { stackApprox: match.stackApprox } : {}) };
}

/** The label the UI shows when a different effective stack was answered from the library. */
export function stackApproxNote(approx: StackApproximation): string {
  return `APPROX STACK: ${approx.libraryStack}BB 계산으로 ${approx.requestedStack}BB 대체`;
}
