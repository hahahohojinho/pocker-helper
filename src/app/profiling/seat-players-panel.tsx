"use client";

import { useState } from "react";
import type { Position } from "@/lib/preflop";
import type { ProfilePlayer, ProfileStats } from "./use-profile";
import { tagLabels, tendencySummary } from "./tendency-labels";

const NEW_PLAYER = "__new__";

/** Assigns saved opponents to seats; assignments rotate with the button between hands. */
export default function SeatPlayersPanel({ positions, heroSeat, seatPlayers, players, stats, onAssign, onCreate }: {
  positions: readonly Position[]; heroSeat: number; seatPlayers: readonly (string | null)[]; players: ProfilePlayer[];
  stats: Record<string, ProfileStats>; onAssign: (seat: number, playerId: string | null) => void; onCreate: (name: string) => Promise<ProfilePlayer>;
}) {
  const [creatingSeat, setCreatingSeat] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const taken = new Set(seatPlayers.filter(Boolean));

  async function create(seat: number) {
    try {
      const player = await onCreate(name);
      onAssign(seat, player.id);
      setCreatingSeat(null);
      setName("");
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "플레이어를 만들지 못했습니다.");
    }
  }

  return <details className="profile-panel">
    <summary>상대 플레이어 배정 <span>{seatPlayers.filter(Boolean).length}명 배정됨</span></summary>
    {positions.map((position, seat) => {
      if (seat === heroSeat) return <div key={position} className="profile-row"><b>{position}</b><span>Hero</span></div>;
      const playerId = seatPlayers[seat] ?? null;
      const classification = playerId ? stats[playerId]?.classification : undefined;
      return <div key={position} className="profile-row">
        <b>{position}</b>
        {creatingSeat === seat
          ? <span className="profile-create"><input value={name} maxLength={40} placeholder="이름" onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === "Enter") void create(seat); }} /><button type="button" onClick={() => void create(seat)}>추가</button><button type="button" onClick={() => setCreatingSeat(null)}>취소</button></span>
          : <select value={playerId ?? ""} onChange={event => event.target.value === NEW_PLAYER ? setCreatingSeat(seat) : onAssign(seat, event.target.value || null)}>
            <option value="">미지정</option>
            {players.filter(player => !player.archived && (player.id === playerId || !taken.has(player.id))).map(player => <option key={player.id} value={player.id}>{player.name}</option>)}
            <option value={NEW_PLAYER}>+ 새 플레이어</option>
          </select>}
        {classification && <small title={classification.tags.map(tag => tagLabels[tag]).join(", ")}>{tendencySummary(classification)}{classification.tags.length ? ` · ${classification.tags.map(tag => tagLabels[tag]).join(", ")}` : ""}</small>}
      </div>;
    })}
    {message && <p className="validation-message">{message}</p>}
    <p>배정한 상대의 액션과 쇼다운 결과가 핸드 종료 후 로컬 DB에 기록됩니다. 다음 핸드로 넘어가면 버튼과 함께 배정이 한 칸씩 회전합니다.</p>
  </details>;
}
