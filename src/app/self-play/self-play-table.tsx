"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { bucketOrder, loadPreflopPack } from "@/lib/preflop-packs";
import { createSeed } from "@/lib/self-play/deck";
import { applyAction, canUndo, committedBySeat, createHand, handTurn, MAX_PLAYERS, MIN_PLAYERS, SLOT_POSITIONS, undoAction, visibleBoard, type SelfPlayHand } from "@/lib/self-play/hand-state";
import { gradePreflop, preflopAdvice } from "@/lib/self-play/preflop-advice";
import { adviceKey, checkedDown, headsUpRequest, streetStartSeats } from "@/lib/self-play/postflop-advice";
import { carryStacks, finishHand } from "@/lib/self-play/settlement";
import { NO_RAKE } from "@/lib/table-config";
import type { PostflopActionType } from "@/lib/postflop-machine";
import { seatCoordinates } from "../table-ui";
import PlayingCard from "./playing-card";
import SelfPlayDock, { ACTION_LABELS, type ActionType } from "./self-play-dock";
import { DecisionList, PostflopAdviceCard, PreflopAdviceCard, type DecisionLog } from "./self-play-advice";
import { useSolverAdvice, type SolveSpot } from "./use-solver-advice";

const MAX_START_STACK = 1000;
const STREET_LABELS = { preflop: "PREFLOP", flop: "FLOP", turn: "TURN", river: "RIVER" } as const;

/** `startStack` is also the rebuy for a player who busts. */
interface Session { baseSeed: number; startStack: number; handNo: number; stacks: number[]; hand: SelfPlayHand; }

/** Each hand of a session gets its own seed, derived from the session seed so a session replays exactly. */
const handSeed = (baseSeed: number, handNo: number) => (baseSeed + handNo) >>> 0;
const newHand = (baseSeed: number, handNo: number, stacks: number[]) => createHand({ seed: handSeed(baseSeed, handNo), handNo, stacks });

function SetupScreen({ onStart }: { onStart: (players: number, stack: number, seed: number) => void }) {
  const [players, setPlayers] = useState(6);
  const [stack, setStack] = useState("100");
  const [seed, setSeed] = useState("");
  const [message, setMessage] = useState("");
  function start() {
    const stackValue = Number(stack);
    if (!Number.isFinite(stackValue) || stackValue < 2 || stackValue > MAX_START_STACK) { setMessage(`시작 스택은 2-${MAX_START_STACK}BB입니다.`); return; }
    if (!Number.isInteger(players) || players < MIN_PLAYERS || players > MAX_PLAYERS) { setMessage(`인원은 ${MIN_PLAYERS}-${MAX_PLAYERS}명입니다.`); return; }
    // Decimal digits only, so the seed shown in the header is exactly the one typed.
    const seedValue = seed.trim() === "" ? createSeed() : /^\d{1,10}$/.test(seed.trim()) ? Number(seed.trim()) : Number.NaN;
    if (!Number.isInteger(seedValue) || seedValue < 0 || seedValue > 0xffffffff) { setMessage("시드는 0 이상의 32비트 정수입니다."); return; }
    onStart(players, Math.round(stackValue * 100) / 100, seedValue);
  }
  return <main className="lobby-shell"><div className="lobby-brand">RANGE<span>LAB</span></div><section className="lobby-card">
    <p className="eyebrow">Self play</p><h1>혼자서<br/>모든 좌석을.</h1>
    <p className="lobby-description">각 좌석에 카드가 딜링되고, 차례가 된 좌석의 카드와 공개된 보드만으로 최적 플레이를 보여줍니다.</p>
    <div className="sp-setup">
      <label>인원<select value={players} onChange={event => setPlayers(Number(event.target.value))}>{Array.from({ length: MAX_PLAYERS - MIN_PLAYERS + 1 }, (_, index) => index + MIN_PLAYERS).map(count => <option key={count} value={count}>{count}명</option>)}</select></label>
      <label>시작 스택 BB<input type="number" min="2" max={MAX_START_STACK} value={stack} onChange={event => setStack(event.target.value)} /></label>
      <label>시드 (비우면 무작위)<input inputMode="numeric" value={seed} onChange={event => setSeed(event.target.value)} /></label>
      <button type="button" onClick={start}>딜 시작</button>
    </div>
    {message && <p className="validation-message">{message}</p>}
    <p className="lobby-description"><Link href="/">액션 빌더로 돌아가기</Link></p>
  </section></main>;
}

export default function SelfPlayTable() {
  const [session, setSession] = useState<Session | null>(null);
  const [hideOthers, setHideOthers] = useState(true);
  const [adviceFirst, setAdviceFirst] = useState(true);
  // The decision point whose advice was revealed: hand number plus action counts, so undo or a new hand hides it again.
  const [adviceShownFor, setAdviceShownFor] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<DecisionLog[]>([]);
  const [message, setMessage] = useState("");
  const [packRevision, setPackRevision] = useState(0);

  const hand = session?.hand ?? null;
  const turn = useMemo(() => hand ? handTurn(hand) : null, [hand]);
  const actingSeat = turn && turn.kind !== "over" ? turn.seat : null;
  const actingCards = hand && actingSeat !== null ? hand.holeCards[actingSeat] : null;
  // packRevision re-runs the lookup after a solved pack finishes loading.
  const advice = useMemo(() => hand && turn?.kind === "preflop" && actingCards ? preflopAdvice(hand, turn.seat, actingCards) : null, [hand, turn, actingCards, packRevision]); // eslint-disable-line react-hooks/exhaustive-deps
  const result = useMemo(() => hand && turn?.kind === "over" ? finishHand(hand, NO_RAKE) : null, [hand, turn]);
  // Heads-up postflop spots go to the DCFR solver with the acting seat's cards only.
  const postflop = useMemo((): { spot: SolveSpot | null; unsupported: string | null } => {
    if (!hand || turn?.kind !== "postflop" || !actingCards) return { spot: null, unsupported: null };
    const seats = streetStartSeats(hand, turn.street);
    if (seats.length !== 2) return { spot: null, unsupported: `${seats.length}인 포스트플랍은 아직 솔버 조언이 없습니다. 헤즈업 스팟만 지원합니다.` };
    try {
      const request = headsUpRequest(hand, turn, actingCards, "native");
      if (!request) return { spot: null, unsupported: "이 스팟은 헤즈업 솔버로 풀 수 없습니다." };
      return { spot: { key: adviceKey(request), street: turn.street, build: (backend, cost) => headsUpRequest(hand, turn, actingCards, backend, cost) }, unsupported: null };
    } catch (error) {
      return { spot: null, unsupported: error instanceof Error ? error.message : "솔버 요청을 만들 수 없습니다." };
    }
  }, [hand, turn, actingCards]);
  const solver = useSolverAdvice(postflop.spot);
  const stackBucket = advice ? bucketOrder(advice.effectiveStack)[0] : null;
  useEffect(() => {
    if (stackBucket === null) return;
    let active = true;
    loadPreflopPack(6, stackBucket).then(pack => { if (active && pack) setPackRevision(value => value + 1); })
      .catch(error => { if (active) setMessage(error instanceof Error ? `프리플랍 솔브 데이터를 불러오지 못했습니다: ${error.message}` : "프리플랍 솔브 데이터를 불러오지 못했습니다."); });
    return () => { active = false; };
  }, [stackBucket]);

  if (!session || !hand || !turn) {
    return <SetupScreen onStart={(players, stack, seed) => {
      const stacks = Array(players).fill(stack);
      setSession({ baseSeed: seed, startStack: stack, handNo: 0, stacks, hand: newHand(seed, 0, stacks) });
      setDecisions([]); setMessage(""); setAdviceShownFor(null);
    }} />;
  }

  const committed = committedBySeat(hand);
  const pot = Math.round(committed.reduce((sum, amount) => sum + amount, 0) * 100) / 100;
  const board = visibleBoard(hand, turn);
  const decisionPoint = `${session.handNo}:${hand.preflop.length}:${hand.postflop.length}`;
  const adviceRevealed = !adviceFirst || adviceShownFor === decisionPoint;
  const solvedEntry = postflop.spot ? solver.entries[postflop.spot.key] : undefined;
  const postflopNotes = [
    ...(session.stacks.length === 2 ? ["APPROX HU: 2인은 6-max SB vs BB로 근사합니다 (SB가 포스트플랍 선행동)."] : []),
    ...(turn.kind === "postflop" && solvedEntry?.status === "done" && checkedDown(solvedEntry.backend, turn) ? ["이후 스트리트 체크다운 근사: 다음 스트리트 베팅 없이 계산된 트리입니다."] : []),
    ...(solver.nativeAvailable === false ? ["네이티브 솔버가 없어 브라우저에서 계산합니다 (느리고 트리가 단순합니다)."] : []),
  ];

  function act(type: ActionType, amount: number) {
    if (!session || !turn || turn.kind === "over") return;
    const applied = applyAction(session.hand, type, amount);
    if (!applied.ok) { setMessage(applied.message); return; }
    const label = `${turn.kind === "preflop" ? "PRE" : STREET_LABELS[turn.street]} ${turn.position} ${ACTION_LABELS[type]}${amount > 0 ? ` ${amount}` : ""}`;
    const grade = turn.kind === "preflop" && advice ? gradePreflop(advice, type as Parameters<typeof gradePreflop>[1]) : undefined;
    // Postflop decisions are graded once their solve is in, even if that is after the action.
    const solve = turn.kind === "postflop" && postflop.spot ? { key: postflop.spot.key, type: type as PostflopActionType, amount, context: turn.context, seat: turn.seat } : undefined;
    if (solve && postflop.spot) solver.enqueue(postflop.spot);
    setDecisions(current => [...current, { id: `${session.handNo}-${current.length}`, label, ...(grade ? { grade } : {}), ...(solve ? { solve } : {}) }]);
    setSession({ ...session, hand: applied.hand });
    setMessage("");
  }
  function undo() {
    if (!session || !canUndo(session.hand)) return;
    setSession({ ...session, hand: undoAction(session.hand) });
    setDecisions(current => current.slice(0, -1));
    setAdviceShownFor(null);
    setMessage("");
  }
  function nextHand() {
    if (!session || !result?.ok) return;
    const stacks = carryStacks(session.hand, result.stacks, session.startStack);
    const handNo = session.handNo + 1;
    setSession({ ...session, handNo, stacks, hand: newHand(session.baseSeed, handNo, stacks) });
    setDecisions([]); setMessage(""); setAdviceShownFor(null); solver.reset();
  }

  const showCards = (seat: number) => !hideOthers || seat === actingSeat || turn.kind === "over";
  return <main className="game-shell v2">
    <header className="game-header"><div className="brand">RANGE<span>LAB</span></div><div className="game-title"><b>SELF PLAY · HAND {session.handNo + 1}</b><span>SEED {handSeed(session.baseSeed, session.handNo)}</span></div><button className="leave-button" onClick={() => setSession(null)}>설정으로</button></header>
    <div className="game-layout v2-layout">
      <section className="table-zone">
        <div className="sp-toggles">
          <label><input type="checkbox" checked={hideOthers} onChange={event => setHideOthers(event.target.checked)} /> 차례가 아닌 좌석 카드 숨기기</label>
          <label><input type="checkbox" checked={adviceFirst} onChange={event => setAdviceFirst(event.target.checked)} /> 조언은 버튼을 눌러야 보기</label>
        </div>
        <div className="poker-scene">
          <div className="poker-table"><div className="sp-board">{board.map(card => <PlayingCard key={card} code={card} />)}</div><div className="pot-chip">POT<br /><b>{pot.toFixed(2)} BB</b></div></div>
          {seatCoordinates[6].map((point, seat) => {
            const player = hand.seatPlayer[seat];
            if (player === null) return null;
            const cards = hand.holeCards[seat]!;
            const folded = [...hand.preflop, ...hand.postflop].some(action => action.seat === seat && action.type === "fold");
            const winner = result?.ok && result.winners.includes(seat);
            return <div key={seat} className={`seat sp-seat ${seat === actingSeat ? "current-turn hero" : ""} ${folded ? "fold" : ""} ${winner ? "sp-winner" : ""}`} style={{ left: `${point.left}%`, top: `${point.top}%` }}>
              <span className="seat-info"><b>P{player + 1} · {SLOT_POSITIONS[seat]}</b><small>{(hand.startStacks[seat] - committed[seat]).toFixed(2)}BB{committed[seat] > 0 ? ` · 투입 ${committed[seat]}` : ""}</small>
                <span className="sp-hole">{cards.map(card => <PlayingCard key={card} code={card} hidden={!showCards(seat)} />)}</span></span>
              {SLOT_POSITIONS[seat] === "BTN" && <i className="dealer">D</i>}
            </div>;
          })}
        </div>
      </section>
      <aside className="action-dock action-builder">
        <div className="selected-player"><small>{turn.kind === "over" ? "HAND OVER" : `${turn.kind === "preflop" ? "PREFLOP" : STREET_LABELS[turn.street]} · 액션 차례`}</small>
          <b>{turn.kind === "over" ? (turn.showdown ? "쇼다운" : "폴드로 종료") : `P${hand.seatPlayer[turn.seat]! + 1} · ${turn.position}`}</b></div>
        {turn.kind === "preflop" && <PreflopAdviceCard advice={advice} revealed={adviceRevealed} onReveal={() => setAdviceShownFor(decisionPoint)} />}
        {turn.kind === "postflop" && <PostflopAdviceCard entry={postflop.spot ? solver.entries[postflop.spot.key] : undefined} solving={postflop.spot !== null && solver.running === postflop.spot.key}
          queued={solver.running !== null && solver.running !== postflop.spot?.key} unsupported={postflop.unsupported} notes={postflopNotes} revealed={adviceRevealed} onReveal={() => setAdviceShownFor(decisionPoint)} onRetry={() => { if (postflop.spot) solver.retry(postflop.spot); }} />}
        {turn.kind !== "over" && <SelfPlayDock key={`${hand.preflop.length}-${hand.postflop.length}`} hand={hand} turn={turn} onAct={act} />}
        {turn.kind === "over" && result && (result.ok
          ? <div className="sp-result">{result.winners.map(seat => <p key={seat}>P{hand.seatPlayer[seat]! + 1} ({SLOT_POSITIONS[seat]}) +{result.payouts[seat]}BB</p>)}<button type="button" onClick={nextHand}>다음 핸드</button></div>
          : <p className="validation-message">{result.message}</p>)}
        {message && <p className="validation-message">{message}</p>}
        <button type="button" className="sp-undo" onClick={undo} disabled={!canUndo(hand)}>↶ 실행 취소</button>
        <DecisionList decisions={decisions} entries={solver.entries} />
      </aside>
    </div>
  </main>;
}
