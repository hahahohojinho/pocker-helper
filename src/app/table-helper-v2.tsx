"use client";

import { useEffect, useMemo, useState } from "react";
import { PlayerAction, PlayerActionType, preflopEffectiveStack, recommendFromHistory } from "@/lib/game-state";
import { Position } from "@/lib/preflop";
import { availableActions, bettingAmounts, nextPosition, positionOrder, validatePreflopAction } from "@/lib/preflop-machine";
import { activeStrategyDataset, buildStrategyMatrix, bundledStrategyDatasetId, clearStrategyDataset, nearestStackBucket, parseStrategyDatasetJson, type PackApproximation } from "@/lib/strategy-data";
import { bucketOrder, loadPreflopPack } from "@/lib/preflop-packs";
import PostflopPanel from "./postflop-panel";
import { calculatePokerPots } from "@/lib/pots";
import { deriveBettingState } from "@/lib/preflop-machine";
import { loadSeatPlayers, parseSeatPlayers, rotateForNextHand, rotateHeroSeat, saveSeatPlayers, type SeatPlayers } from "@/lib/profiling/build-record";
import SeatPlayersPanel from "./profiling/seat-players-panel";
import { MIN_STACK, REBUY_STACK } from "./profiling/hand-recorder-panel";
import { loadAnteSetting, loadRakeSetting, MAX_RAKE_CAP_BB, MAX_RAKE_PERCENT, parseAnteSetting, parseRakeSetting, saveAnteSetting, saveRakeSetting, type RakeSetting } from "@/lib/table-config";
import { hasAnte, MAX_ANTE_BB, postAntes, type AnteKind } from "@/lib/antes";
import { tendencySummary } from "./profiling/tendency-labels";
import { useProfile } from "./profiling/use-profile";
import PreflopExploitCard from "./exploit/preflop-exploit-card";
import IcmPanel from "./icm-panel";

type TableSize = 6 | 8;
const packErrorPrefix="프리플랍 솔브 데이터를 불러오지 못했습니다";
const positionSets: Record<TableSize, Position[]> = { 6:["BTN","SB","BB","UTG","HJ","CO"], 8:["BTN","SB","BB","UTG","UTG+1","MP","HJ","CO"] };
const coordinates: Record<TableSize,{left:number;top:number}[]> = {
  6:[{left:50,top:92},{left:12,top:72},{left:12,top:24},{left:50,top:4},{left:88,top:24},{left:88,top:72}],
  8:[{left:50,top:94},{left:18,top:87},{left:5,top:52},{left:18,top:15},{left:50,top:4},{left:82,top:15},{left:95,top:52},{left:82,top:87}],
};
const actionLabels:Record<PlayerActionType,string>={fold:"Fold",check:"Check",limp:"Limp",open:"Open",call:"Call","3bet":"3-bet","4bet":"4-bet","5bet":"5-bet"};
const strategyStorageKey="rangelab.preflop-dataset.v1";
const browserLocalStorage=()=>{try{return typeof window==="undefined"?null:window.localStorage;}catch{return null;}};
function approximationNote(approx:PackApproximation){
  const parts=[approx.stack&&`APPROX STACK: ${approx.packStack}BB 팩으로 ${approx.requestedStack}BB 대체`,approx.size&&`APPROX SIZE: ${approx.packSize}BB 사이즈로 ${approx.requestedSize}BB 대체`].filter(Boolean);
  return ` · ${parts.join(" · ")}`;
}

export default function TableHelperV2(){
  const [tableSize,setTableSize]=useState<TableSize|null>(null);
  const [heroSeat,setHeroSeat]=useState(0);
  const [selectedSeat,setSelectedSeat]=useState(3);
  const [actions,setActions]=useState<PlayerAction[]>([]);
  const [amount,setAmount]=useState(2.5);
  const [hand,setHand]=useState("AQs");
  const [stacks,setStacks]=useState<number[]>(Array(8).fill(100));
  const [validationMessage,setValidationMessage]=useState("");
  const [datasetRevision,setDatasetRevision]=useState(0);
  const [datasetMessage,setDatasetMessage]=useState("");
  const [stackDraft,setStackDraft]=useState<string|null>(null);
  const [seatPlayersBySize,setSeatPlayersBySize]=useState<SeatPlayers>(()=>parseSeatPlayers(null));
  const [seatPlayersLoaded,setSeatPlayersLoaded]=useState(false);
  // Remounts the postflop panel (and its recorder) for each new hand.
  const [handNumber,setHandNumber]=useState(0);
  // The inputs keep the typed text (so "0.5" can be entered); only a valid pair (both above 0, within limits)
  // becomes the table rake. Loaded after mount so the server render and the first client render agree.
  const [rakeDraft,setRakeDraft]=useState<{percent:string;capBb:string}>({percent:"",capBb:""});
  useEffect(()=>{queueMicrotask(()=>{const saved=loadRakeSetting(browserLocalStorage());if(saved.percent)setRakeDraft({percent:String(saved.percent),capBb:String(saved.capBb)});});},[]);
  const rake=parseRakeSetting({percent:Number(rakeDraft.percent),capBb:Number(rakeDraft.capBb)});
  function updateRake(field:keyof RakeSetting,value:string){
    const draft={...rakeDraft,[field]:value};
    setRakeDraft(draft);
    saveRakeSetting(browserLocalStorage(),parseRakeSetting({percent:Number(draft.percent),capBb:Number(draft.capBb)}));
  }
  // Antes (tournaments): same draft pattern as the rake. Locked while a hand has actions, since changing the
  // playable stacks mid-hand could make recorded amounts invalid.
  const [anteDraft,setAnteDraft]=useState<{kind:AnteKind;amount:string}>({kind:"none",amount:""});
  useEffect(()=>{queueMicrotask(()=>{const saved=loadAnteSetting(browserLocalStorage());if(hasAnte(saved))setAnteDraft({kind:saved.kind,amount:String(saved.amount)});});},[]);
  const ante=useMemo(()=>parseAnteSetting({kind:anteDraft.kind,amount:Number(anteDraft.amount)}),[anteDraft]);
  function updateAnte(next:{kind:AnteKind;amount:string}){
    setAnteDraft(next);
    saveAnteSetting(browserLocalStorage(),parseAnteSetting({kind:next.kind,amount:Number(next.amount)}));
  }
  const [profileRevision,setProfileRevision]=useState(0);
  const positions=positionSets[tableSize??6];
  const seatPlayers=seatPlayersBySize[tableSize??6];
  const profile=useProfile(tableSize,seatPlayers,profileRevision);
  const statsBySeat=useMemo(()=>seatPlayers.map(id=>id?profile.stats[id]?.totals:undefined),[seatPlayers,profile.stats]);
  const playerName=(seat:number)=>profile.players.find(player=>player.id===seatPlayers[seat])?.name;
  const heroStack=stacks[heroSeat]??100;
  // The betting engine plays the stacks left after the antes; antes join the pot as dead money.
  const anteSetup=useMemo(()=>postAntes(stacks,positions,ante),[stacks,positions,ante]);
  const playStacks=anteSetup.playStacks;
  // Packs and charts are looked up by the stack that bounds Hero's decision, not Hero's own stack.
  const effectiveStack=preflopEffectiveStack(playStacks,heroSeat,actions)||playStacks[heroSeat]||heroStack;
  // datasetRevision re-runs the lookup once an imported dataset or a solved pack has been installed into the
  // module-level strategy registry, which React cannot observe.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const result=useMemo(()=>recommendFromHistory({heroPosition:positions[heroSeat],hand,effectiveStack,actions,tableSize:tableSize??undefined}),[positions,heroSeat,hand,effectiveStack,actions,tableSize,datasetRevision]);
  const currentPosition=nextPosition(actions,positions,playStacks);
  const currentSeat=currentPosition ? positions.indexOf(currentPosition) : -1;
  const allowed=currentSeat>=0 ? availableActions(actions,positions,currentSeat,playStacks) : [];
  const accounting=bettingAmounts(actions,positions,Math.max(0,currentSeat),playStacks,anteSetup.deadMoney);
  const bettingState=deriveBettingState(actions,positions,playStacks,anteSetup.deadMoney);
  const potLayers=calculatePokerPots(bettingState.contributions,bettingState.foldedSeats,bettingState.allInSeats);
  const visibleActions=actions.filter(action=>!action.implicit);
  const strategyMatrix=buildStrategyMatrix(positions[heroSeat],effectiveStack,result.scenario,result.spotContext,tableSize??undefined);

  // Solved packs are per table size and stack bucket, so the load only re-runs when the nearest bucket changes.
  const stackBucket=bucketOrder(effectiveStack)[0];
  useEffect(()=>{
    if(!tableSize)return;
    let active=true;
    const clearPackError=()=>setDatasetMessage(message=>message.startsWith(packErrorPrefix)?"":message);
    loadPreflopPack(tableSize,stackBucket).then(pack=>{if(!active)return;clearPackError();if(pack)setDatasetRevision(value=>value+1);})
      .catch(error=>{if(active)setDatasetMessage(error instanceof Error?`${packErrorPrefix}: ${error.message}`:`${packErrorPrefix}.`);});
    return()=>{active=false;};
  },[tableSize,stackBucket]);
  const datasetInfo=activeStrategyDataset();
  const stackSeat=currentSeat>=0?currentSeat:heroSeat;
  const stackLocked=currentSeat<0||actions.some(action=>action.seat===stackSeat&&!action.implicit);

  useEffect(()=>{
    let active=true;
    queueMicrotask(()=>{if(!active)return;setSeatPlayersBySize(loadSeatPlayers());setSeatPlayersLoaded(true);});
    return()=>{active=false;};
  },[]);
  // Saved only after the first load, so the empty initial state never overwrites stored assignments.
  useEffect(()=>{if(seatPlayersLoaded)saveSeatPlayers(seatPlayersBySize);},[seatPlayersBySize,seatPlayersLoaded]);
  // Assignments pointing at players the database no longer has (e.g. a replaced DB file) would make every save fail.
  const playerIdsKey=profile.enabled?profile.players.map(player=>player.id).sort().join(","):null;
  useEffect(()=>{
    if(playerIdsKey===null||!seatPlayersLoaded)return;
    const known=new Set(playerIdsKey.split(",").filter(Boolean));
    queueMicrotask(()=>setSeatPlayersBySize(current=>{
      const prune=(list:(string|null)[])=>list.map(id=>id&&known.has(id)?id:null);
      const next={6:prune(current[6]),8:prune(current[8])};
      return JSON.stringify(next)===JSON.stringify(current)?current:next;
    }));
  },[playerIdsKey,seatPlayersLoaded]);

  useEffect(()=>{
    let active=true;
    queueMicrotask(()=>{if(!active)return;const saved=localStorage.getItem(strategyStorageKey);if(!saved)return;
      try{const dataset=parseStrategyDatasetJson(saved);setDatasetRevision(value=>value+1);setDatasetMessage(`${dataset.id} 자동 복원 · ${activeStrategyDataset()?.spots} spots · ${dataset.license}`);}
      catch{localStorage.removeItem(strategyStorageKey);clearStrategyDataset();setDatasetMessage("저장된 전략 데이터가 유효하지 않아 내장 DCFR 데이터로 복원했습니다.");}
    });
    return()=>{active=false;};
  },[]);

  async function importDataset(file:File|undefined){
    if(!file)return;
    try{if(file.size>5_000_000)throw new Error("파일은 5 MB 이하여야 합니다.");const text=await file.text();const dataset=parseStrategyDatasetJson(text);let persistence="영구 저장";try{localStorage.setItem(strategyStorageKey,text);}catch{persistence="현재 세션만";}setDatasetRevision(value=>value+1);setDatasetMessage(`${dataset.id} · ${activeStrategyDataset()?.spots} spots · ${dataset.license} · ${persistence}`);}
    catch(error){setDatasetMessage(error instanceof Error?error.message:"데이터셋을 가져오지 못했습니다.");}
  }
  function resetDataset(){clearStrategyDataset();localStorage.removeItem(strategyStorageKey);setDatasetRevision(value=>value+1);setDatasetMessage("내장 DCFR 데이터로 복원하고 저장된 데이터셋을 삭제했습니다.");}

  function updateSeatPlayers(next:(current:(string|null)[])=>(string|null)[]){
    if(!tableSize)return;
    setSeatPlayersBySize(current=>({...current,[tableSize]:next(current[tableSize])}));
  }
  /** One player per seat: assigning a player already seated elsewhere moves them. */
  function assignPlayer(seat:number,playerId:string|null){updateSeatPlayers(current=>current.map((value,index)=>index===seat?playerId:playerId!==null&&value===playerId?null:value));}
  /** The button moves one seat: players, the hero, and stacks all shift one slot, and the hand starts over. */
  function startNextHand(settledStacks?:number[]){
    if(!tableSize)return;
    updateSeatPlayers(rotateForNextHand);
    setHeroSeat(seat=>rotateHeroSeat(seat,tableSize));
    // Settled stacks from the hand recorder carry over; a seat that busted (below the record minimum) rebuys.
    const carried=(current:number[])=>current.slice(0,tableSize).map((stack,seat)=>{const settled=settledStacks?.[seat];if(settled===undefined||!Number.isFinite(settled))return stack;return settled<MIN_STACK?REBUY_STACK:settled;});
    setStacks(current=>rotateForNextHand(carried(current)));
    setActions([]);setSelectedSeat(3);setValidationMessage("");setHandNumber(value=>value+1);
  }
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
    if(anteSetup.shortSeats.length){setValidationMessage(`${anteSetup.shortSeats.map(seat=>positions[seat]).join(", ")} 스택이 앤티와 블라인드보다 작습니다. 스택이나 앤티를 고치세요.`);return;}
    const check=validatePreflopAction({actions,positions,seat:currentSeat,type,amount,effectiveStack:playStacks[currentSeat],stacks:playStacks});
    if(!check.valid){setValidationMessage(check.message);if(check.minimumAmount!==undefined)setAmount(check.minimumAmount);return;}
    const needsAmount=["limp","open","call","3bet","4bet","5bet"].includes(type);
    setActions(current=>[...current,{id:crypto.randomUUID(),street:"preflop",seat:currentSeat,position:positions[currentSeat],type,amount:needsAmount?amount:0}]);
    setValidationMessage("");
  }
  function removeLast(){setActions(current=>current.slice(0,-1))}
  function changeHeroSeat(seat:number){
    if(seat===heroSeat)return;
    setHeroSeat(seat);
    updateSeatPlayers(current=>current.map((id,index)=>index===seat?null:id));
    if(actions.length){setActions([]);setValidationMessage("Hero 좌석이 바뀌어 액션 기록을 초기화했습니다.");}
  }
  function commitStack(){
    if(stackDraft===null)return;
    const value=Number(stackDraft);
    // The new stack must still cover this seat's bets plus its ante.
    const committed=(bettingState.contributions.get(stackSeat)??0)+(anteSetup.posted[stackSeat]??0);
    setStackDraft(null);
    if(stackLocked)return;
    if(stackDraft.trim()===""||!Number.isFinite(value)||value<=committed){setValidationMessage(`${positions[stackSeat]} 시작 스택은 ${committed}BB보다 커야 합니다.`);return;}
    setStacks(current=>current.map((stack,index)=>index===stackSeat?value:stack));
    setValidationMessage("");
  }

  if(!tableSize)return <main className="lobby-shell"><div className="lobby-brand">RANGE<span>LAB</span></div><section className="lobby-card"><p className="eyebrow">Choose your table</p><h1>테이블을<br/>선택하세요.</h1><p className="lobby-description">인원에 맞춰 좌석과 포지션, 액션 순서를 구성합니다.</p><div className="table-choices">{([6,8] as const).map(size=><button key={size} onClick={()=>enter(size)}><span className="mini-table"><i/><i/><i/><i/><i/><i/>{size===8&&<><i/><i/></>}</span><b>{size}-MAX</b><small>{size}인 테이블</small><em>입장하기 →</em></button>)}</div></section></main>;

  return <main className="game-shell v2">
    <header className="game-header"><div className="brand">RANGE<span>LAB</span></div><div className="game-title"><b>{tableSize}-MAX · PREFLOP</b><span>ACTION BUILDER</span></div><button className="leave-button" onClick={()=>setTableSize(null)}>테이블 나가기</button></header>
    <div className="history-strip"><b>ACTION HISTORY</b><div>{visibleActions.length===0?<span className="empty-history">입력하지 않은 앞 좌석은 자동 Fold로 처리됩니다</span>:visibleActions.map((a,i)=><span className={`history-chip ${a.type}`} key={a.id}><small>{i+1}</small>{a.position} <b>{actionLabels[a.type]}</b>{a.amount>0&&` ${a.amount}BB`}</span>)}</div><button onClick={removeLast} disabled={!actions.length}>↶ 실행 취소</button></div>
    <div className="game-layout v2-layout">
      <section className="table-zone">
        <div className="instruction"><span>{currentPosition?"CURRENT SCENARIO":"ROUND COMPLETE"}</span><b>{currentPosition?result.scenarioLabel:"프리플랍 액션 완료"}</b><small>{currentPosition?"액션을 순서대로 입력하세요. Hero 액션도 기록하면 다음 차례로 진행됩니다.":"모든 활성 플레이어가 현재 베팅 금액을 맞췄습니다."}</small></div>
        <div className="poker-scene">
          <div className="poker-table"><div className="felt-mark"><b>RANGE<span>LAB</span></b><small>ACTION BUILDER</small></div><div className="pot-chip">POT<br/><b>{accounting.pot.toFixed(1)} BB</b></div></div>
          {coordinates[tableSize].map((point,index)=>{const last=[...actions].reverse().find(a=>a.seat===index);return <button key={index} className={`seat ${index===heroSeat?"hero":""} ${index===selectedSeat?"selected":""} ${index===currentSeat?"current-turn":""} ${last?.type??(!last&&index!==heroSeat?"auto-fold":"")}`} style={{left:`${point.left}%`,top:`${point.top}%`}} onClick={()=>selectActingSeat(index)}><span className="avatar">{index===heroSeat?"YOU":index+1}</span><span className="seat-info"><b>{positions[index]}</b><small>{index===currentSeat?"현재 차례":last?`${actionLabels[last.type]} ${last.amount||""}`:index===heroSeat?hand:"Fold · 자동"}</small>{index!==heroSeat&&playerName(index)&&<small className="seat-profile" title={playerName(index)}>{playerName(index)}{profile.stats[seatPlayers[index]??""]?` · ${tendencySummary(profile.stats[seatPlayers[index]??""].classification)}`:""}</small>}</span>{positions[index]==="BTN"&&<i className="dealer">D</i>}</button>})}
        </div>
        <div className="hero-seat-row"><span>내 좌석</span>{positions.map((p,i)=><button key={p} className={heroSeat===i?"active":""} onClick={()=>changeHeroSeat(i)}>{p}</button>)}</div>
      </section>
      <aside className="action-dock action-builder">
        <div className="selected-player"><small>현재 액션 차례</small><b>{currentPosition?`SEAT ${currentSeat+1} · ${currentPosition}${currentSeat===heroSeat?" · HERO":""}`:"BETTING ROUND COMPLETE"}</b></div>
        <div className="bet-accounting"><span><small>현재 팟</small><b>{accounting.pot.toFixed(1)} BB</b></span><span><small>콜 필요액</small><b>{accounting.toCall.toFixed(1)} BB</b></span><span><small>최소 레이즈</small><b>{accounting.minimumRaiseTo.toFixed(1)} BB</b></span><span><small>남은 스택</small><b>{accounting.remainingStack.toFixed(1)} BB</b></span></div>
        {potLayers.length>1&&<div className="side-pot-list">{potLayers.map((pot,index)=><span key={pot.cap}><small>{index===0?"MAIN POT":`SIDE POT ${index}`}</small><b>{pot.amount.toFixed(1)}BB</b><em>{pot.eligibleSeats.length} eligible</em></span>)}</div>}
        <p className="auto-fold-note">Hero 액션을 기록하면 이후 재액션까지 입력 가능</p><div className="action-buttons seven">{(["fold","check","limp","open","call","3bet","4bet","5bet"] as PlayerActionType[]).map(type=><button key={type} disabled={!allowed.includes(type)} onClick={()=>addAction(type)}>{actionLabels[type]}</button>)}</div>
        {validationMessage&&<p className="validation-message">{validationMessage}</p>}
        <label className="amount-field">액션 후 총 투입액<div><input type="number" min="0" max={currentSeat>=0?playStacks[currentSeat]:heroStack} step="0.5" value={amount} onChange={e=>setAmount(Number(e.target.value))}/><b>BB</b></div><span className="amount-presets"><button onClick={()=>setAmount(accounting.currentBet)}>Call {accounting.currentBet}BB</button><button onClick={()=>setAmount(accounting.minimumRaiseTo)}>Min {accounting.minimumRaiseTo}BB</button><button onClick={()=>setAmount(currentSeat>=0?stacks[currentSeat]:heroStack)}>All-in {currentSeat>=0?stacks[currentSeat]:heroStack}BB</button></span></label>
        <div className="rake-inputs"><label>레이크 %<input type="number" min="0" max={MAX_RAKE_PERCENT} step="0.5" value={rakeDraft.percent} placeholder="0" onChange={e=>updateRake("percent",e.target.value)}/></label><label>캡 BB<input type="number" min="0" max={MAX_RAKE_CAP_BB} step="0.5" value={rakeDraft.capBb} placeholder="0" onChange={e=>updateRake("capBb",e.target.value)}/></label><small>{rake.percent?`헤즈업 DCFR 솔버와 핸드 정산에 ${rake.percent}% · 캡 ${rake.capBb}BB 적용 (플랍 라이브러리 미사용)`:"레이크 없음"}</small><label>앤티<select value={anteDraft.kind} disabled={actions.length>0} onChange={e=>updateAnte({...anteDraft,kind:e.target.value as AnteKind})}><option value="none">없음</option><option value="seat">좌석별</option><option value="bb">BB 앤티</option></select></label>{anteDraft.kind!=="none"&&<label>앤티 BB<input type="number" min="0" max={MAX_ANTE_BB} step="0.05" value={anteDraft.amount} disabled={actions.length>0} placeholder="0" onChange={e=>updateAnte({...anteDraft,amount:e.target.value})}/></label>}{hasAnte(ante)&&<small>{ante.kind==="bb"?"BB가 테이블 앤티":"좌석마다 앤티"} {ante.amount}BB · 팟에 {anteSetup.deadMoney}BB 데드머니{actions.length>0?" · 핸드 중에는 변경 불가":""}{anteSetup.shortSeats.length?` · ${anteSetup.shortSeats.map(seat=>positions[seat]).join(", ")} 스택 부족`:""}</small>}</div>
        <div className="hero-inputs"><label>내 핸드<input value={hand} maxLength={3} onChange={e=>setHand(e.target.value)}/></label><label>{currentSeat>=0?`${positions[currentSeat]} 시작 스택`:"Hero 시작 스택"}<input type="number" min="1" value={stackDraft??stacks[stackSeat]} disabled={stackLocked} title={stackLocked?"이미 액션한 좌석의 스택은 실행 취소 후 변경하세요.":undefined} onChange={e=>setStackDraft(e.target.value)} onBlur={commitStack} onKeyDown={e=>{if(e.key==="Enter")e.currentTarget.blur()}}/></label></div>
        {currentPosition?<><div className="action-result compact"><p>{currentSeat===heroSeat?"RECOMMENDED ACTION":"HERO DECISION PREVIEW"} <span>신뢰도 {result.confidence}</span></p><h2>{result.primaryDisplay}</h2><p>{currentSeat===heroSeat?result.summary:"상대 액션을 계속 입력하면 Hero 차례에 최종 추천을 표시합니다."}</p></div><div className="frequency-list">{result.displayFrequencies.map(item=><div key={item.action}><span>{item.action}</span><i><b style={{width:`${item.frequency}%`}}/></i><strong>{item.frequency}%</strong></div>)}</div><details className="range-matrix"><summary>169 핸드 전략표 보기 <span>{positions[heroSeat]} · {nearestStackBucket(effectiveStack)}BB</span></summary><div>{strategyMatrix.map(cell=><span key={cell.hand} className={cell.aggressive>=50?"range-aggressive":cell.passive>=40?"range-passive":"range-fold"} title={`Fold ${cell.fold}% / Passive ${cell.passive}% / Aggressive ${cell.aggressive}%`}>{cell.hand}</span>)}</div><p><i/>공격적 액션 <i/>패시브 액션 <i/>Fold</p></details></>:<div className="preflop-complete-card"><small>PREFLOP COMPLETE</small><b>{accounting.pot.toFixed(1)} BB POT</b><span>아래에서 플랍 보드와 액션을 입력하세요.</span></div>}
        {tableSize&&currentSeat===heroSeat&&<PreflopExploitCard tableSize={tableSize} positions={positions} heroSeat={heroSeat} hand={hand} stacks={playStacks} deadMoney={anteSetup.deadMoney} actions={actions} statsBySeat={statsBySeat}/>}
        {profile.enabled&&<SeatPlayersPanel positions={positions} heroSeat={heroSeat} seatPlayers={seatPlayers} players={profile.players} stats={profile.stats} onAssign={assignPlayer} onCreate={profile.createPlayer}/>}
        <p className="solver-note">CURRENT SOURCE · {result.strategySource}{result.strategySource==="baseline-v1"?" · NOT GTO FALLBACK":result.strategySource.startsWith("pack:")?" · SOLVED PACK (rangelab-preflop MCCFR)":" · LICENSED DATASET"}{effectiveStack!==heroStack&&` · 유효 스택 ${effectiveStack}BB`}{result.strategyApproximation&&<span className="approx-note">{approximationNote(result.strategyApproximation)}</span>}{hasAnte(ante)&&<span className="approx-note"> · APPROX ANTE: 프리플랍 데이터는 앤티 없는 기준</span>}</p>
        <IcmPanel positions={positions} stacks={stacks} heroSeat={heroSeat}/>
        <details className="strategy-import"><summary>STRATEGY DATA · {datasetInfo?.id}</summary><label>검증된 JSON 데이터셋 불러오기<input type="file" accept="application/json,.json" onChange={event=>void importDataset(event.target.files?.[0])}/></label>{datasetInfo?.id!==bundledStrategyDatasetId&&<button type="button" onClick={resetDataset}>기본 DCFR로 복원</button>}{datasetInfo&&<small>{datasetInfo.contract} · {datasetInfo.spots} spots · {datasetInfo.license}</small>}{datasetInfo?.provenance&&<small>{datasetInfo.provenance.generator} · {datasetInfo.provenance.revision.slice(0,12)} · {datasetInfo.provenance.iterations.toLocaleString()} iterations · seed {datasetInfo.provenance.seed}</small>}{datasetMessage&&<small>{datasetMessage}</small>}<p>각 spot은 169핸드 전체, 빈도 합 100%, 라이선스 메타데이터가 필요합니다. 검증된 데이터는 이 브라우저에 저장됩니다.</p></details>
        {!currentPosition&&<PostflopPanel key={handNumber} rake={rake} ante={ante} positions={positions} preflopActions={actions} stacks={stacks} heroSeat={heroSeat} exploit={tableSize?{tableSize,statsBySeat}:undefined} recorder={{tableSize,heroHand:hand,seatPlayers,profileEnabled:profile.enabled,onSaved:()=>setProfileRevision(value=>value+1),onNextHand:startNextHand}}/>} 
      </aside>
    </div>
  </main>;
}
