"use client";

import { useEffect, useState } from "react";
import { MISS_LABELS, type FlopLibraryMiss } from "@/lib/flop-library/lookup";
import { queryFlopLibrary, stackApproxNote } from "@/lib/flop-library/query";
import { parseSolverResult, type SolverResult } from "@/lib/solver-adapter";
import type { WasmSolveRequest } from "@/lib/wasm-solver/request";

type Lookup = { key: string; result: SolverResult; scenario: string } | { key: string; miss: FlopLibraryMiss } | { key: string; unavailable: true };

/** Looks the request up in the locally generated flop library; "unavailable" when no library exists. */
async function lookUp(key: string, request: WasmSolveRequest): Promise<Lookup> {
  const answer = await queryFlopLibrary(request);
  if (!("raw" in answer)) return { key, ...answer };
  const approx = answer.stackApprox ? ` · ${stackApproxNote(answer.stackApprox)}` : "";
  return { key, result: parseSolverResult(answer.raw), scenario: `${answer.scenarioLabel} · ${answer.generatedAt}${approx}` };
}

/**
 * Instant answer for a heads-up flop decision from precomputed solutions. Shown only when the library holds the
 * spot (same ranges, pot, sizes, and line; effective stack within STACK_TOLERANCE); otherwise the live solver answers.
 */
export default function FlopLibraryCard({ request, requestKey, onApply }: {
  request: WasmSolveRequest | null; requestKey: string; onApply: (result: SolverResult) => void;
}) {
  const [lookup, setLookup] = useState<Lookup | null>(null);
  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    lookUp(requestKey, request)
      .catch(error => { console.warn("Flop library lookup failed", error); return { key: requestKey, unavailable: true as const }; })
      .then(value => { if (!cancelled) setLookup(value); });
    return () => { cancelled = true; };
    // The key covers every field of the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey]);
  const current = request && lookup?.key === requestKey ? lookup : null;
  if (!current || "unavailable" in current) return null;
  if ("miss" in current) return <p className="local-solver-help">FLOP LIBRARY 미적용: {MISS_LABELS[current.miss]}. 라이브 Solver를 사용하세요.</p>;
  const { result } = current;
  return <section className="ev-panel">
    <div className="ev-head">
      <b>FLOP LIBRARY</b><span className="solver-source">사전 계산 · SOLVER EV</span>
      {result.exploitability !== undefined && <span className="convergence">EXPLOIT {result.exploitability.toFixed(2)}% POT</span>}
    </div>
    {result.actions.map(item => <div className="ev-row" key={item.action}>
      <span>{item.action}</span><i><b style={{ width: `${item.frequency}%` }} /></i>
      <strong>{item.frequency.toFixed(1)}%{item.ev !== undefined && ` · ${item.ev >= 0 ? "+" : ""}${item.ev.toFixed(2)}BB`}</strong>
    </div>)}
    {/* The library was solved with the flop-only tree (P0-4 rebuild pending), like the live flop solve. */}
    <small className="ev-note">{current.scenario} · 이후 스트리트 체크다운 근사 · <button type="button" onClick={() => onApply(result)}>EV 패널에 적용</button></small>
  </section>;
}
