"use client";

import type { PostflopContext } from "@/lib/postflop-hand-state";
import type { PostflopActionType } from "@/lib/postflop-machine";
import type { PreflopAdvice, PreflopGrade } from "@/lib/self-play/preflop-advice";
import { gradePostflop, type PostflopGrade } from "@/lib/self-play/postflop-advice";
import { exploitabilityLevel } from "@/lib/solver-presets";
import { approximationNote } from "../table-ui";
import type { AdviceEntry } from "./use-solver-advice";

/** A postflop decision waiting for (or graded by) the solve stored under `key`. */
export interface PendingSolveGrade { key: string; type: PostflopActionType; amount: number; context: PostflopContext; seat: number; }

export interface DecisionLog {
  id: string;
  label: string;
  /** Present when the decision had preflop strategy advice to grade against. */
  grade?: PreflopGrade;
  solve?: PendingSolveGrade;
}

const VERDICT_LABELS: Record<PreflopGrade["verdict"], string> = { good: "전략 라인", mixed: "가끔 쓰는 라인", mistake: "거의 쓰지 않는 라인" };
/** EV loss in BB under which a postflop choice counts as fine, and above which it is a clear mistake. */
const SMALL_LOSS_BB = 0.1;
const BIG_LOSS_BB = 1;
const CONVERGENCE_LABELS = { ok: "수렴 양호", warn: "수렴 부족", bad: "수렴 미흡", unknown: "수렴도 미측정" } as const;

/** The pack strategy for the seat to act; hidden behind a button when the player wants to decide first. */
export function PreflopAdviceCard({ advice, note, revealed, onReveal }: { advice: PreflopAdvice | null; note: string | null; revealed: boolean; onReveal: () => void }) {
  if (!advice) return <div className="sp-advice"><small>프리플랍 조언</small><p>이 좌석의 카드로 조언을 만들 수 없습니다.</p></div>;
  if (!revealed) return <div className="sp-advice"><small>프리플랍 조언</small><button type="button" onClick={onReveal}>조언 보기</button><p>먼저 액션을 고르면 선택 후 채점됩니다.</p></div>;
  return <div className="sp-advice">
    <small>프리플랍 조언 · {advice.hand} · {advice.scenarioLabel} · 유효 {advice.effectiveStack}BB</small>
    <div className="sp-freqs">{advice.displayFrequencies.map(entry => <span key={entry.action} className={entry.action === advice.primaryDisplay ? "primary" : ""}><b>{entry.frequency}%</b>{entry.action}</span>)}</div>
    <p className="sp-source">{advice.strategySource}{advice.strategyApproximation ? approximationNote(advice.strategyApproximation) : ""}</p>
    {note && <p className="sp-source">{note}</p>}
  </div>;
}

/** Heads-up solver answer for the seat to act, or why there is none. */
export function PostflopAdviceCard(props: {
  entry: AdviceEntry | undefined; solving: boolean; queued: boolean; notes: string[]; revealed: boolean; onReveal: () => void; onRetry: () => void;
}) {
  const { entry, solving, queued, notes, revealed, onReveal, onRetry } = props;
  if (!entry) return <div className="sp-advice"><small>포스트플랍 조언</small><p>{solving ? "계산 중… (헤즈업: 턴/리버 약 4.5초, 베팅을 받으면 약 9초, 플랍 약 9초 / 3인 턴 약 8초 / 모델 수 초)" : queued ? "앞선 스팟 계산이 끝나면 시작합니다." : "준비 중"}</p><p>기다리지 않고 액션해도 결과가 나오면 채점됩니다.</p></div>;
  if (entry.status === "error") return <div className="sp-advice"><small>포스트플랍 조언</small><p className="validation-message">{entry.message}</p><button type="button" onClick={onRetry}>다시 계산</button></div>;
  if (!revealed) return <div className="sp-advice"><small>포스트플랍 조언 · 계산 완료</small><button type="button" onClick={onReveal}>조언 보기</button></div>;
  const { kind, result, details, note } = entry.advice;
  const model = kind === "model";
  // 3-way CFR reports the largest best-response gain instead of exploitability.
  const convergence = result.maxBrGain ?? result.exploitability;
  const level = exploitabilityLevel(convergence);
  return <div className="sp-advice">
    <small>{entry.method} · {(entry.elapsedMs / 1000).toFixed(1)}초{model ? " · 근사 모델" : ` · ${CONVERGENCE_LABELS[level]}${convergence !== undefined ? ` ${convergence.toFixed(2)}%` : ""}`}</small>
    <div className="sp-freqs">{result.actions.map(action => <span key={action.action} className={action.action === result.bestAction ? "primary" : ""}><b>{model ? `EV ${(action.ev ?? 0).toFixed(2)}` : `${Math.round(action.frequency)}%`}</b>{action.action}{!model && action.ev !== undefined ? ` · EV ${action.ev.toFixed(2)}` : ""}</span>)}</div>
    {details.length > 0 && <ul className="sp-sizes">{details.map((row, index) => <li key={`${index}-${row.label}`}><span>{row.label}{row.amount !== undefined ? ` (${row.amount})` : ""}</span><b>{model ? "" : `${Math.round(row.frequency * 100)}%`}</b><em>EV {row.ev.toFixed(2)}</em></li>)}</ul>}
    {[...notes, ...entry.notes, ...(note ? [note] : [])].map((text, index) => <p key={index} className="sp-source">{text}</p>)}
    {entry.retryable && <button type="button" onClick={onRetry}>솔버로 다시 계산</button>}
  </div>;
}

function postflopLine(grade: PostflopGrade, model: boolean) {
  return `${grade.chosenLabel}${model ? "" : ` ${Math.round(grade.chosenFrequency * 100)}%`} · EV 손실 ${grade.evLoss.toFixed(2)}BB · 최선 ${grade.bestLabel}${model ? " · MODEL 근사" : ""}${grade.sizeApprox ? " (사이즈 미반영)" : ""}`;
}
const postflopVerdict = (grade: PostflopGrade) => grade.evLoss <= SMALL_LOSS_BB ? "good" : grade.evLoss <= BIG_LOSS_BB ? "mixed" : "mistake";

export function DecisionList({ decisions, entries }: { decisions: readonly DecisionLog[]; entries: Readonly<Record<string, AdviceEntry>> }) {
  if (!decisions.length) return null;
  const evLoss = decisions.reduce((total, decision) => {
    const entry = decision.solve ? entries[decision.solve.key] : undefined;
    const grade = entry?.status === "done" && decision.solve ? gradePostflop(entry.advice, decision.solve.type, decision.solve.amount, decision.solve.context, decision.solve.seat) : null;
    return total + (grade?.evLoss ?? 0);
  }, 0);
  return <>
    <ol className="sp-decisions">
      {decisions.map(decision => {
        if (decision.grade) return <li key={decision.id} className={decision.grade.verdict}><span>{decision.label}</span>
          <small>{VERDICT_LABELS[decision.grade.verdict]} · 선택 {Math.round(decision.grade.frequency * 100)}% · 최다 {decision.grade.best} {Math.round(decision.grade.bestFrequency * 100)}%</small></li>;
        const entry = decision.solve ? entries[decision.solve.key] : undefined;
        const grade = entry?.status === "done" && decision.solve ? gradePostflop(entry.advice, decision.solve.type, decision.solve.amount, decision.solve.context, decision.solve.seat) : null;
        const pending = decision.solve && !entry ? "솔버 결과 대기 중" : entry?.status === "error" ? "솔버 실패로 채점 없음" : "채점 없음";
        return <li key={decision.id} className={grade ? postflopVerdict(grade) : "ungraded"}><span>{decision.label}</span><small>{grade && entry?.status === "done" ? postflopLine(grade, entry.advice.kind === "model") : pending}</small></li>;
      })}
    </ol>
    {evLoss > 0 && <p className="sp-total">이번 핸드 포스트플랍 EV 손실 합계 {evLoss.toFixed(2)}BB</p>}
  </>;
}
