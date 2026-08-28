"use client";

import { useEffect, useMemo, useState } from "react";
import { PlayerAction, PlayerActionType, recommendFromHistory } from "@/lib/game-state";
import { Position } from "@/lib/preflop";
import { availableActions, bettingAmounts, nextPosition, positionOrder, validatePreflopAction } from "@/lib/preflop-machine";
import { activeStrategyDataset, buildStrategyMatrix, clearStrategyDataset, nearestStackBucket, parseStrategyDatasetJson } from "@/lib/strategy-data";
import PostflopPanel from "./postflop-panel";
import { calculatePokerPots } from "@/lib/pots";
import { deriveBettingState } from "@/lib/preflop-machine";

type TableSize = 6 | 8;
const positionSets: Record<TableSize, Position[]> = { 6:["BTN","SB","BB","UTG","HJ","CO"], 8:["BTN","SB","BB","UTG","UTG+1","MP","HJ","CO"] };
const coordinates: Record<TableSize,{left:number;top:number}[]> = {
  6:[{left:50,top:92},{left:12,top:72},{left:12,top:24},{left:50,top:4},{left:88,top:24},{left:88,top:72}],
  8:[{left:50,top:94},{left:18,top:87},{left:5,top:52},{left:18,top:15},{left:50,top:4},{left:82,top:15},{left:95,top:52},{left:82,top:87}],
};
const actionLabels:Record<PlayerActionType,string>={fold:"Fold",check:"Check",limp:"Limp",open:"Open",call:"Call","3bet":"3-bet","4bet":"4-bet","5bet":"5-bet"};
const strategyStorageKey="rangelab.preflop-dataset.v1";

export default function TableHelperV2(){
  const [tableSize,setTableSize]=useState<TableSize|null>(null);
  const [heroSeat,setHeroSeat]=useState(0);
  const [selectedSeat,setSelectedSeat]=useState(3);
  const [actions,setActions]=useState<PlayerAction[]>([]);
  const [amount,setAmount]=useState(2.5);
  const [hand,setHand]=useState("AQs");
  const [stacks,setStacks]=useState<number[]>(Array(8).fill(100));
  const [validationMessage,setValidationMessage]=useState("");
  const [,setDatasetRevision]=useState(0);
  const [datasetMessage,setDatasetMessage]=useState("");
  const positions=positionSets[tableSize??6];
  const heroStack=stacks[heroSeat]??100;
  const result=useMemo(()=>recommendFromHistory({heroPosition:positions[heroSeat],hand,effectiveStack:heroStack,actions}),[positions,heroSeat,hand,heroStack,actions]);
  const currentPosition=nextPosition(actions,positions,stacks);
  const currentSeat=currentPosition ? positions.indexOf(currentPosition) : -1;
  const allowed=currentSeat>=0 ? availableActions(actions,positions,currentSeat,stacks) : [];
  const accounting=bettingAmounts(actions,positions,Math.max(0,currentSeat),stacks);
  const bettingState=deriveBettingState(actions,positions,stacks);
  const potLayers=calculatePokerPots(bettingState.contributions,bettingState.foldedSeats,bettingState.allInSeats);
  const visibleActions=actions.filter(action=>!action.implicit);
  const strategyMatrix=buildStrategyMatrix(positions[heroSeat],heroStack,result.scenario,result.spotContext);
  const datasetInfo=activeStrategyDataset();

  useEffect(()=>{
    let active=true;
    queueMicrotask(()=>{if(!active)return;const saved=localStorage.getItem(strategyStorageKey);if(!saved)return;
      try{const dataset=parseStrategyDatasetJson(saved);setDatasetRevision(value=>value+1);setDatasetMessage(`${dataset.id} 자동 복원 · ${activeStrategyDataset()?.spots} spots · ${dataset.license}`);}
      catch{localStorage.removeItem(strategyStorageKey);clearStrategyDataset();setDatasetMessage("저장된 전략 데이터가 유효하지 않아 baseline-v1으로 복원했습니다.");}
    });
    return()=>{active=false;};
  },[]);

  async function importDataset(file:File|undefined){
    if(!file)return;
    try{if(file.size>5_000_000)throw new Error("파일은 5 MB 이하여야 합니다.");const text=await file.text();const dataset=parseStrategyDatasetJson(text);let persistence="영구 저장";try{localStorage.setItem(strategyStorageKey,text);}catch{persistence="현재 세션만";}setDatasetRevision(value=>value+1);setDatasetMessage(`${dataset.id} · ${activeStrategyDataset()?.spots} spots · ${dataset.license} · ${persistence}`);}
    catch(error){setDatasetMessage(error instanceof Error?error.message:"데이터셋을 가져오지 못했습니다.");}
  }
  function resetDataset(){clearStrategyDataset();localStorage.removeItem(strategyStorageKey);setDatasetRevision(value=>value+1);setDatasetMessage("baseline-v1으로 복원하고 저장된 데이터셋을 삭제했습니다.");}

  function enter(size:TableSize){setTableSize(size);setHeroSeat(0);setSelectedSeat(3);setActions([]);setStacks(Array(size).fill(100))}
  function selectActingSeat(seat:number){
    if(!currentPosition){setValidationMessage("프리플랍 베팅 라운드가 종료되었습니다.");return;}
    if(currentSeat===heroSeat&&seat!==heroSeat){setValidationMessage(`${currentPosition} Hero의 액션 차례를 건너뛸 수 없습니다.`);return;}
    if(seat!==currentSeat){
      const order=positionOrder(positions);
      const from=order.indexOf(currentPosition);
      const target=order.indexOf(positions[seat]);
      const hero=order.indexOf(positions[heroSeat]);
      const distance=(target-from+order.length)%order.length;
      const heroDistance=(hero-from+order.length)%order.length;
      if(distance===0||heroDistance<distance){setValidationMessage(`Hero(${positions[heroSeat]}) 차례 이후 좌석은 아직 선택할 수 없습니다.`);return;}
      const implicitFolds:PlayerAction[]=[];
      for(let step=0;step<distance;step++){
        const position=order[(from+step)%order.length];
        const skippedSeat=positions.indexOf(position);
        implicitFolds.push({id:crypto.randomUUID(),street:"preflop",seat:skippedSeat,position,type:"fold",amount:0,implicit:true});
      }
      setActions(current=>[...current,...implicitFolds]);
    }
    setSelectedSeat(seat);setValidationMessage("");
  }
  function addAction(type:PlayerActionType){
    if(currentSeat<0){setValidationMessage("프리플랍 베팅 라운드가 종료되었습니다.");return;}
    const check=validatePreflopAction({actions,positions,seat:currentSeat,type,amount,effectiveStack:stacks[currentSeat],stacks});
    if(!check.valid){setValidationMessage(check.message);if(check.minimumAmount!==undefined)setAmount(check.minimumAmount);return;}
    const needsAmount=["limp","open","call","3bet","4bet","5bet"].includes(type);
    setActions(current=>[...current,{id:crypto.randomUUID(),street:"preflop",seat:currentSeat,position:positions[currentSeat],type,amount:needsAmount?amount:0}]);
    setValidationMessage("");
  }
  function removeLast(){setActions(current=>current.slice(0,-1))}

  if(!tableSize)return <main className="lobby-shell"><div className="lobby-brand">RANGE<span>LAB</span></div><section className="lobby-card"><p className="eyebrow">Choose your table</p><h1>테이블을<br/>선택하세요.</h1><p className="lobby-description">인원에 맞춰 좌석과 포지션, 액션 순서를 구성합니다.</p><div className="table-choices">{([6,8] as const).map(size=><button key={size} onClick={()=>enter(size)}><span className="mini-table"><i/><i/><i/><i/><i/><i/>{size===8&&<><i/><i/></>}</span><b>{size}-MAX</b><small>{size}인 테이블</small><em>입장하기 →</em></button>)}</div></section></main>;

  return <main className="game-shell v2">
    <header className="game-header"><div className="brand">RANGE<span>LAB</span></div><div className="game-title"><b>{tableSize}-MAX · PREFLOP</b><span>ACTION BUILDER</span></div><button className="leave-button" onClick={()=>setTableSize(null)}>테이블 나가기</button></header>
    <div className="history-strip"><b>ACTION HISTORY</b><div>{visibleActions.length===0?<span className="empty-history">입력하지 않은 앞 좌석은 자동 Fold로 처리됩니다</span>:visibleActions.map((a,i)=><span className={`history-chip ${a.type}`} key={a.id}><small>{i+1}</small>{a.position} <b>{actionLabels[a.type]}</b>{a.amount>0&&` ${a.amount}BB`}</span>)}</div><button onClick={removeLast} disabled={!actions.length}>↶ 실행 취소</button></div>
    <div className="game-layout v2-layout">
      <section className="table-zone">
        <div className="instruction"><span>{currentPosition?"CURRENT SCENARIO":"ROUND COMPLETE"}</span><b>{currentPosition?result.scenarioLabel:"프리플랍 액션 완료"}</b><small>{currentPosition?"액션을 순서대로 입력하세요. Hero 액션도 기록하면 다음 차례로 진행됩니다.":"모든 활성 플레이어가 현재 베팅 금액을 맞췄습니다."}</small></div>
        <div className="poker-scene">
          <div className="poker-table"><div className="felt-mark"><b>RANGE<span>LAB</span></b><small>ACTION BUILDER</small></div><div className="pot-chip">POT<br/><b>{accounting.pot.toFixed(1)} BB</b></div></div>
          {coordinates[tableSize].map((point,index)=>{const last=[...actions].reverse().find(a=>a.seat===index);return <button key={index} className={`seat ${index===heroSeat?"hero":""} ${index===selectedSeat?"selected":""} ${index===currentSeat?"current-turn":""} ${last?.type??(!last&&index!==heroSeat?"auto-fold":"")}`} style={{left:`${point.left}%`,top:`${point.top}%`}} onClick={()=>selectActingSeat(index)}><span className="avatar">{index===heroSeat?"YOU":index+1}</span><span className="seat-info"><b>{positions[index]}</b><small>{index===currentSeat?"현재 차례":last?`${actionLabels[last.type]} ${last.amount||""}`:index===heroSeat?hand:"Fold · 자동"}</small></span>{positions[index]==="BTN"&&<i className="dealer">D</i>}</button>})}
        </div>
        <div className="hero-seat-row"><span>내 좌석</span>{positions.map((p,i)=><button key={p} className={heroSeat===i?"active":""} onClick={()=>{setHeroSeat(i);setActions(a=>a.filter(x=>x.seat!==i))}}>{p}</button>)}</div>
      </section>
      <aside className="action-dock action-builder">
        <div className="selected-player"><small>현재 액션 차례</small><b>{currentPosition?`SEAT ${currentSeat+1} · ${currentPosition}${currentSeat===heroSeat?" · HERO":""}`:"BETTING ROUND COMPLETE"}</b></div>
        <div className="bet-accounting"><span><small>현재 팟</small><b>{accounting.pot.toFixed(1)} BB</b></span><span><small>콜 필요액</small><b>{accounting.toCall.toFixed(1)} BB</b></span><span><small>최소 레이즈</small><b>{accounting.minimumRaiseTo.toFixed(1)} BB</b></span><span><small>남은 스택</small><b>{accounting.remainingStack.toFixed(1)} BB</b></span></div>
        {potLayers.length>1&&<div className="side-pot-list">{potLayers.map((pot,index)=><span key={pot.cap}><small>{index===0?"MAIN POT":`SIDE POT ${index}`}</small><b>{pot.amount.toFixed(1)}BB</b><em>{pot.eligibleSeats.length} eligible</em></span>)}</div>}
        <p className="auto-fold-note">Hero 액션을 기록하면 이후 재액션까지 입력 가능</p><div className="action-buttons seven">{(["fold","check","limp","open","call","3bet","4bet","5bet"] as PlayerActionType[]).map(type=><button key={type} disabled={!allowed.includes(type)} onClick={()=>addAction(type)}>{actionLabels[type]}</button>)}</div>
        {validationMessage&&<p className="validation-message">{validationMessage}</p>}
        <label className="amount-field">액션 후 총 투입액<div><input type="number" min="0" max={currentSeat>=0?stacks[currentSeat]:heroStack} step="0.5" value={amount} onChange={e=>setAmount(Number(e.target.value))}/><b>BB</b></div><span className="amount-presets"><button onClick={()=>setAmount(accounting.currentBet)}>Call {accounting.currentBet}BB</button><button onClick={()=>setAmount(accounting.minimumRaiseTo)}>Min {accounting.minimumRaiseTo}BB</button><button onClick={()=>setAmount(currentSeat>=0?stacks[currentSeat]:heroStack)}>All-in {currentSeat>=0?stacks[currentSeat]:heroStack}BB</button></span></label>
        <div className="hero-inputs"><label>내 핸드<input value={hand} maxLength={3} onChange={e=>setHand(e.target.value)}/></label><label>{currentSeat>=0?`${positions[currentSeat]} 시작 스택`:"Hero 시작 스택"}<input type="number" min="1" value={currentSeat>=0?stacks[currentSeat]:heroStack} onChange={e=>{const seat=currentSeat>=0?currentSeat:heroSeat;setStacks(current=>current.map((value,index)=>index===seat?Number(e.target.value):value))}}/></label></div>
        {currentPosition?<><div className="action-result compact"><p>{currentSeat===heroSeat?"RECOMMENDED ACTION":"HERO DECISION PREVIEW"} <span>신뢰도 {result.confidence}</span></p><h2>{result.primaryDisplay}</h2><p>{currentSeat===heroSeat?result.summary:"상대 액션을 계속 입력하면 Hero 차례에 최종 추천을 표시합니다."}</p></div><div className="frequency-list">{result.displayFrequencies.map(item=><div key={item.action}><span>{item.action}</span><i><b style={{width:`${item.frequency}%`}}/></i><strong>{item.frequency}%</strong></div>)}</div><details className="range-matrix"><summary>169 핸드 전략표 보기 <span>{positions[heroSeat]} · {nearestStackBucket(heroStack)}BB</span></summary><div>{strategyMatrix.map(cell=><span key={cell.hand} className={cell.aggressive>=50?"range-aggressive":cell.passive>=40?"range-passive":"range-fold"} title={`Fold ${cell.fold}% / Passive ${cell.passive}% / Aggressive ${cell.aggressive}%`}>{cell.hand}</span>)}</div><p><i/>공격적 액션 <i/>패시브 액션 <i/>Fold</p></details></>:<div className="preflop-complete-card"><small>PREFLOP COMPLETE</small><b>{accounting.pot.toFixed(1)} BB POT</b><span>아래에서 플랍 보드와 액션을 입력하세요.</span></div>}
        <p className="solver-note">CURRENT SOURCE · {result.strategySource}{result.strategySource==="baseline-v1"?" · NOT GTO FALLBACK":" · LICENSED DATASET"}</p>
        <details className="strategy-import"><summary>STRATEGY DATA · {datasetInfo?datasetInfo.id:"baseline-v1"}</summary><label>검증된 JSON 데이터셋 불러오기<input type="file" accept="application/json,.json" onChange={event=>void importDataset(event.target.files?.[0])}/></label>{datasetInfo&&<button type="button" onClick={resetDataset}>BASELINE으로 복원</button>}{datasetInfo&&<small>{datasetInfo.contract} · {datasetInfo.spots} spots · {datasetInfo.license}</small>}{datasetInfo?.provenance&&<small>{datasetInfo.provenance.generator} · {datasetInfo.provenance.revision.slice(0,12)} · {datasetInfo.provenance.iterations.toLocaleString()} iterations · seed {datasetInfo.provenance.seed}</small>}{datasetMessage&&<small>{datasetMessage}</small>}<p>각 spot은 169핸드 전체, 빈도 합 100%, 라이선스 메타데이터가 필요합니다. 검증된 데이터는 이 브라우저에 저장됩니다.</p></details>
        {!currentPosition&&<PostflopPanel positions={positions} preflopActions={actions} stacks={stacks} heroSeat={heroSeat}/>} 
      </aside>
    </div>
  </main>;
}
