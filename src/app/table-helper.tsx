"use client";

import { useMemo, useState } from "react";
import { Position, recommendPreflop } from "@/lib/preflop";

type TableSize = 6 | 8;
type PickMode = "hero" | "villain";

const positionSets: Record<TableSize, Position[]> = {
  6: ["BTN", "SB", "BB", "UTG", "HJ", "CO"],
  8: ["BTN", "SB", "BB", "UTG", "UTG+1", "MP", "HJ", "CO"],
};

const seatCoordinates: Record<TableSize, { left: number; top: number }[]> = {
  6: [
    { left: 50, top: 92 }, { left: 12, top: 72 }, { left: 12, top: 24 },
    { left: 50, top: 4 }, { left: 88, top: 24 }, { left: 88, top: 72 },
  ],
  8: [
    { left: 50, top: 94 }, { left: 18, top: 87 }, { left: 5, top: 52 }, { left: 18, top: 15 },
    { left: 50, top: 4 }, { left: 82, top: 15 }, { left: 95, top: 52 }, { left: 82, top: 87 },
  ],
};

export default function TableHelper() {
  const [tableSize, setTableSize] = useState<TableSize | null>(null);
  const [heroSeat, setHeroSeat] = useState(0);
  const [villainSeat, setVillainSeat] = useState(5);
  const [pickMode, setPickMode] = useState<PickMode>("hero");
  const [hand, setHand] = useState("AQs");
  const [openSize, setOpenSize] = useState(2.5);
  const [effectiveStack, setEffectiveStack] = useState(100);

  const positions = tableSize ? positionSets[tableSize] : positionSets[6];
  const heroPosition = positions[heroSeat] ?? "BTN";
  const villainPosition = positions[villainSeat] ?? "CO";
  const result = useMemo(() => recommendPreflop({ heroPosition, villainPosition, hand, openSize, effectiveStack }), [heroPosition, villainPosition, hand, openSize, effectiveStack]);

  function enter(size: TableSize) {
    setTableSize(size);
    setHeroSeat(0);
    setVillainSeat(size - 1);
  }

  function selectSeat(index: number) {
    if (pickMode === "hero") {
      if (index === villainSeat) setVillainSeat(index === 0 ? 1 : 0);
      setHeroSeat(index);
      setPickMode("villain");
    } else {
      if (index !== heroSeat) setVillainSeat(index);
    }
  }

  if (!tableSize) {
    return (
      <main className="lobby-shell">
        <div className="lobby-brand">RANGE<span>LAB</span></div>
        <section className="lobby-card">
          <p className="eyebrow">Choose your table</p>
          <h1>어떤 테이블에<br/>앉으시겠어요?</h1>
          <p className="lobby-description">게임 인원에 맞는 테이블을 선택하면 좌석별 포지션이 자동으로 설정됩니다.</p>
          <div className="table-choices">
            {[6, 8].map(size => (
              <button key={size} onClick={() => enter(size as TableSize)}>
                <span className="mini-table"><i/><i/><i/><i/><i/><i/>{size === 8 && <><i/><i/></>}</span>
                <b>{size}-MAX</b><small>{size}인 테이블</small><em>입장하기 →</em>
              </button>
            ))}
          </div>
          <p className="lobby-note">현재 캐시게임 · 프리플랍 · 헤즈업 팟을 지원합니다.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="game-shell">
      <header className="game-header">
        <div className="brand">RANGE<span>LAB</span></div>
        <div className="game-title"><b>{tableSize}-MAX CASH</b><span>NLHE · 100BB</span></div>
        <button className="leave-button" onClick={() => setTableSize(null)}>테이블 나가기</button>
      </header>

      <div className="game-layout">
        <section className="table-zone">
          <div className="instruction"><span>STEP {pickMode === "hero" ? "1" : "2"}</span><b>{pickMode === "hero" ? "내 좌석을 선택하세요" : "오픈한 상대 좌석을 선택하세요"}</b><small>좌석을 클릭하면 포지션이 자동 입력됩니다.</small></div>
          <div className={`poker-scene seats-${tableSize}`}>
            <div className="poker-table"><div className="felt-mark"><b>RANGE<span>LAB</span></b><small>{tableSize}-MAX · NO LIMIT HOLD&apos;EM</small></div><div className="pot-chip">POT<br/><b>{(openSize + 1.5).toFixed(1)} BB</b></div></div>
            {seatCoordinates[tableSize].map((point, index) => {
              const role = index === heroSeat ? "hero" : index === villainSeat ? "villain" : "";
              return <button key={index} className={`seat ${role}`} style={{ left: `${point.left}%`, top: `${point.top}%` }} onClick={() => selectSeat(index)}>
                <span className="avatar">{role === "hero" ? "YOU" : index + 1}</span><span className="seat-info"><b>{positions[index]}</b><small>{role === "hero" ? hand : role === "villain" ? `OPEN ${openSize}BB` : "선택"}</small></span>{positions[index] === "BTN" && <i className="dealer">D</i>}
              </button>;
            })}
          </div>
          <div className="role-switch"><button className={pickMode === "hero" ? "active" : ""} onClick={() => setPickMode("hero")}><i className="hero-dot"/>내 좌석 변경</button><button className={pickMode === "villain" ? "active" : ""} onClick={() => setPickMode("villain")}><i className="villain-dot"/>오픈 상대 변경</button></div>
        </section>

        <aside className="action-dock">
          <div className="dock-section"><p className="dock-label">YOUR HAND</p><input className="card-input" value={hand} maxLength={3} onChange={e => setHand(e.target.value)} /><small>AA · AQs · AKo 형식</small></div>
          <div className="dock-grid">
            <label>오픈 사이즈<div><input type="number" value={openSize} min="2" max="10" step="0.1" onChange={e => setOpenSize(Number(e.target.value))}/><b>BB</b></div></label>
            <label>유효 스택<div><input type="number" value={effectiveStack} min="10" max="300" step="5" onChange={e => setEffectiveStack(Number(e.target.value))}/><b>BB</b></div></label>
          </div>
          <div className="matchup"><span><small>HERO</small><b>{heroPosition}</b></span><em>VS</em><span><small>OPENER</small><b>{villainPosition}</b></span></div>
          <div className="action-result"><p>RECOMMENDED ACTION <span>신뢰도 {result.confidence}</span></p><h2>{result.primary}</h2><p>{result.summary}</p></div>
          <div className="frequency-list">{(["Fold", "Call", "3-bet"] as const).map(action => <div key={action}><span>{action}</span><i><b style={{width:`${result.frequencies[action]}%`}}/></i><strong>{result.frequencies[action]}%</strong></div>)}</div>
          <p className="solver-note">현재 결과는 일반 레인지 기반 교육용 휴리스틱이며 솔버 출력이 아닙니다.</p>
        </aside>
      </div>
    </main>
  );
}
