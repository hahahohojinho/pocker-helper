"use client";

import { useMemo, useRef, useState } from "react";
import type { PlayerAction } from "@/lib/game-state";
import type { PostflopAction } from "@/lib/postflop-machine";
import type { Position } from "@/lib/preflop";
import { buildHandRecord } from "@/lib/profiling/build-record";
import { parseHandRecord, type ProfileTableSize } from "@/lib/profiling/hand-record";
import { replayHandRecord } from "@/lib/profiling/hand-replay";
import { saveHandRecord } from "./use-profile";

const pendingLabels: Record<string, string> = {
  "preflop is not finished": "프리플랍 진행 중",
  "the hand has not reached showdown": "아직 쇼다운 전입니다",
  "the board needs five cards for showdown": "쇼다운하려면 보드 5장을 입력하세요",
};
const splitCards = (text: string) => text.replace(/[^2-9TJQKAcdhsCDHS]/g, "").match(/.{1,2}/g)?.slice(0, 2) ?? [];

/** Shows whether the hand is over, collects shown cards and winners, and saves the hand to the profile database. */
export default function HandRecorderPanel({ tableSize, positions, stacks, heroSeat, heroHand, heroCards, seatPlayers, preflopActions, postflopActions, board, profileEnabled, onSaved, onNextHand }: {
  tableSize: ProfileTableSize; positions: readonly Position[]; stacks: readonly number[]; heroSeat: number; heroHand: string; heroCards: readonly string[];
  seatPlayers: readonly (string | null)[]; preflopActions: PlayerAction[]; postflopActions: PostflopAction[]; board: readonly string[];
  profileEnabled: boolean; onSaved: () => void; onNextHand: () => void;
}) {
  const [shown, setShown] = useState<Record<number, string>>({});
  const [winners, setWinners] = useState<number[]>([]);
  const [message, setMessage] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  // One id per hand, kept across retries so a repeated save is recognized as the same hand.
  const recordId = useRef<string | null>(null);

  const evaluation = useMemo(() => {
    const holeCards: Record<number, string[]> = { [heroSeat]: [...heroCards] };
    for (const [seat, text] of Object.entries(shown)) holeCards[Number(seat)] = splitCards(text);
    const draft = (ids: { id: string; playedAt: string }, chosen: number[]) => buildHandRecord({ ...ids, tableSize, heroSeat, heroHand, stacks, seatPlayers, preflop: preflopActions, postflop: postflopActions, board, holeCards, winners: chosen });
    // Who is still in decides which winners can be chosen, so this replay skips the winner check.
    const probe = replayHandRecord(draft({ id: "00000000-0000-4000-8000-000000000000", playedAt: new Date(0).toISOString() }, []), { checkWinners: false });
    if (!probe.ok) return { error: probe.message, end: null, draft };
    return { error: "", end: probe.end, draft };
  }, [shown, heroSeat, heroCards, tableSize, heroHand, stacks, seatPlayers, preflopActions, postflopActions, board]);
  const end = evaluation.end;
  const chosenWinners = end && !end.showdown ? end.liveSeats : winners.filter(seat => end?.liveSeats.includes(seat));

  async function save() {
    recordId.current ??= crypto.randomUUID();
    setSaving(true);
    try {
      const record = parseHandRecord(evaluation.draft({ id: recordId.current, playedAt: new Date().toISOString() }, chosenWinners));
      const replay = replayHandRecord(record);
      if (!replay.ok) throw new Error(replay.message);
      const result = await saveHandRecord(record);
      setSaved(true);
      setMessage(result.status === "duplicate" ? "이미 저장된 핸드입니다." : "핸드를 저장했습니다.");
      onSaved();
    } catch (error) {
      setMessage(error instanceof Error ? `저장 실패: ${error.message}` : "저장 실패");
    } finally {
      setSaving(false);
    }
  }

  const status = evaluation.error ? `기록 검증 실패: ${evaluation.error}`
    : !end?.finished ? (pendingLabels[end?.pending ?? ""] ?? end?.pending ?? "")
    : end.showdown ? "핸드 종료 · 쇼다운" : `핸드 종료 · ${positions[end.liveSeats[0]]} 승리`;
  return <section className="profile-panel hand-recorder">
    <p className="profile-status"><small>HAND RECORD</small><b>{status}</b></p>
    {end?.finished && end.showdown && <div className="showdown-inputs">
      {end.liveSeats.map(seat => <label key={seat}>
        <span>{positions[seat]}{seat === heroSeat ? " · Hero" : ""}</span>
        {seat !== heroSeat && <input value={shown[seat] ?? ""} maxLength={5} placeholder="공개 카드 (예: AhKd)" onChange={event => setShown(current => ({ ...current, [seat]: event.target.value }))} />}
        <input type="checkbox" checked={winners.includes(seat)} onChange={event => setWinners(current => event.target.checked ? [...current, seat] : current.filter(value => value !== seat))} /> 승자
      </label>)}
    </div>}
    <div className="recorder-buttons">
      {profileEnabled && <button type="button" disabled={!end?.finished || saving || saved || chosenWinners.length === 0} onClick={() => void save()}>{saved ? "저장됨" : "핸드 저장"}</button>}
      <button type="button" onClick={onNextHand}>다음 핸드 →</button>
    </div>
    {message && <small className="profile-message">{message}</small>}
  </section>;
}
