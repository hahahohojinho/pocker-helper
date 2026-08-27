"use client";

import { useMemo, useState } from "react";
import { Position, recommendPreflop } from "@/lib/preflop";

const positions: Position[] = ["UTG", "HJ", "CO", "BTN", "SB", "BB"];

export default function PokerHelper() {
  const [heroPosition, setHeroPosition] = useState<Position>("BTN");
  const [villainPosition, setVillainPosition] = useState<Position>("CO");
  const [hand, setHand] = useState("AQs");
  const [openSize, setOpenSize] = useState(2.5);
  const [effectiveStack, setEffectiveStack] = useState(100);
  const result = useMemo(() => recommendPreflop({ heroPosition, villainPosition, hand, openSize, effectiveStack }), [heroPosition, villainPosition, hand, openSize, effectiveStack]);

  return (
    <main className="shell">
      <header className="topbar"><a className="brand" href="#">RANGE<span>LAB</span></a><div className="stage-pill"><i /> PRE-FLOP · MVP</div></header>
      <section className="hero-copy">
        <p className="eyebrow">Decision assistant / 6-max NLHE</p>
        <h1>숫자로 확인하는<br/><em>다음 액션.</em></h1>
        <p>상황을 입력하면 일반적인 레인지를 기준으로 액션 빈도와 판단 근거를 계산합니다.</p>
      </section>
      <div className="workspace">
        <section className="panel form-panel">
          <div className="panel-head"><span>01</span><div><h2>게임 상황</h2><p>상대가 오픈했고, 당신 차례인 상황</p></div></div>
          <div className="field-grid">
            <label>내 포지션<select value={heroPosition} onChange={(e) => setHeroPosition(e.target.value as Position)}>{positions.map(p => <option key={p}>{p}</option>)}</select></label>
            <label>상대 오픈 위치<select value={villainPosition} onChange={(e) => setVillainPosition(e.target.value as Position)}>{positions.map(p => <option key={p}>{p}</option>)}</select></label>
            <label className="hand-field">내 핸드<input value={hand} onChange={(e) => setHand(e.target.value)} maxLength={3} placeholder="예: AQs"/><small>페어: JJ · 수딧: AQs · 오프수딧: AKo</small></label>
            <label>오픈 사이즈<div className="unit-input"><input type="number" min="2" max="10" step="0.1" value={openSize} onChange={(e) => setOpenSize(Number(e.target.value))}/><b>BB</b></div></label>
            <label>유효 스택<div className="unit-input"><input type="number" min="10" max="300" step="5" value={effectiveStack} onChange={(e) => setEffectiveStack(Number(e.target.value))}/><b>BB</b></div></label>
          </div>
          <div className="scope-note"><b>현재 지원 범위</b><span>6-max · 캐시게임 · 헤즈업 팟 · 프리플랍</span></div>
        </section>
        <section className="panel result-panel">
          <div className="panel-head"><span>02</span><div><h2>추천 액션</h2><p>현재 입력값에 즉시 반영됩니다</p></div></div>
          <div className="recommendation"><span className="confidence">신뢰도 {result.confidence}</span><p>PRIMARY ACTION</p><h3>{result.primary}</h3><p className="summary">{result.summary}</p></div>
          <div className="frequencies">
            {(["Fold", "Call", "3-bet"] as const).map(action => <div className="freq" key={action}><div><span>{action}</span><strong>{result.frequencies[action]}%</strong></div><div className="track"><i style={{ width: `${result.frequencies[action]}%` }} /></div></div>)}
          </div>
          <div className="assumptions"><b>계산 가정</b>{result.assumptions.map(item => <p key={item}>— {item}</p>)}</div>
        </section>
      </div>
      <footer>학습 및 핸드 리뷰용 도구입니다. 실제 게임에서는 해당 포커룸의 이용 규정을 확인하세요.</footer>
    </main>
  );
}
