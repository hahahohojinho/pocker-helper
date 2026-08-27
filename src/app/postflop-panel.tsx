"use client";

import { useMemo, useState } from "react";
import type { PlayerAction, Street } from "@/lib/game-state";
import type { Position } from "@/lib/preflop";
import { deriveBettingState } from "@/lib/preflop-machine";
import { postflopOrder, PostflopAction, PostflopActionType } from "@/lib/postflop-machine";
import { availablePostflopActions, buildPostflopContext, nextPostflopActor, validatePostflopActionV2 } from "@/lib/postflop-hand-state";
import { calculateEquity, EquityResult } from "@/lib/equity";
import { attachActionEvs, estimateActionEvs } from "@/lib/decision-ev";
import { createSolverNode, parseSolverResult, parseTexasSolverNode, SolverResult } from "@/lib/solver-adapter";
import { calculateRangeEquity } from "@/lib/range-equity";
import { conditionRangeOnPostflop, inferRangeFromPreflop, toTexasSolverRange } from "@/lib/range-model";

const labels:Record<PostflopActionType,string>={fold:"Fold",check:"Check",bet:"Bet",call:"Call",raise:"Raise"};
const nextStreet={flop:"turn",turn:"river"} as const;
const baselineRange="AA,KK,QQ,JJ,TT,99,88,77,66,55,44,33,22,AKs,AQs,AJs,ATs,A9s,A8s,A7s,A6s,A5s,A4s,A3s,A2s,KQs,KJs,KTs,QJs,QTs,JTs,T9s,98s,87s,76s,65s,54s,AKo,AQo,AJo,KQo";

export default function PostflopPanel({positions,preflopActions,stacks,heroSeat}:{positions:Position[];preflopActions:PlayerAction[];stacks:number[];heroSeat:number}){
  const preflop=deriveBettingState(preflopActions,positions,stacks);
  const activeSeats=positions.map((_,seat)=>seat).filter(seat=>!preflop.foldedSeats.has(seat));
  const nonActingSeats=new Set([...preflop.foldedSeats,...preflop.allInSeats]);
  const order=postflopOrder(positions,nonActingSeats);
  const initialRemaining=stacks.map((stack,seat)=>Math.max(0,stack-(preflop.contributions.get(seat)??0)));
  const [street,setStreet]=useState<Exclude<Street,"preflop">>("flop");
  const [board,setBoard]=useState(["","","","",""]);
  const [actions,setActions]=useState<PostflopAction[]>([]);
  const [amount,setAmount]=useState(Math.max(1,Math.round(preflop.pot)/2));
  const [message,setMessage]=useState("");
  const [holeCards,setHoleCards]=useState(["As","Qh"]);
  const [equity,setEquity]=useState<EquityResult|null>(null);
  const [solverText,setSolverText]=useState("");
  const [solverResult,setSolverResult]=useState<SolverResult|null>(null);
  const [solving,setSolving]=useState(false);
  const [rangeBySeat,setRangeBySeat]=useState<Record<number,string>>({});
  const inferredRanges=Object.fromEntries(activeSeats.filter(seat=>seat!==heroSeat).map(seat=>[seat,inferRangeFromPreflop({actions:preflopActions,seat,position:positions[seat],stack:stacks[seat]})]));
  const heroInferredRange=inferRangeFromPreflop({actions:preflopActions,seat:heroSeat,position:positions[heroSeat],stack:stacks[heroSeat]});
  const rangeFor=(seat:number)=>rangeBySeat[seat]??conditionRangeOnPostflop({rangeText:inferredRanges[seat]?.text??baselineRange,boardCodes:board.slice(0,boardCount).filter(card=>card.length===2),actions:actions.filter(action=>action.seat===seat).map(action=>action.type)});
  const streetActions=useMemo(()=>actions.filter(action=>action.street===street),[actions,street]);
  const context=buildPostflopContext({actions,street,seats:activeSeats,initialRemaining,initialPot:preflop.pot});
  const actor=nextPostflopActor(context,order);
  const allowed=actor===null?[]:availablePostflopActions(context,actor);
  const pot=context.pot;
  const liveSeats=activeSeats.filter(seat=>!context.foldedSeats.has(seat));
  const effectiveStack=Math.min(...liveSeats.map(seat=>context.remainingAtStart[seat]??0));
  const boardCount=street==="flop"?3:street==="turn"?4:5;

  function setCard(index:number,value:string){const normalized=value.replace(/[^2-9TJQKAcdhsCDHS]/g,"").slice(0,2);setBoard(current=>current.map((card,i)=>i===index?normalized:card));}
  function add(type:PostflopActionType){
    if(actor===null)return;
    const check=validatePostflopActionV2(context,actor,type,amount);
    if(!check.valid){setMessage(check.message);if(check.minimumAmount)setAmount(check.minimumAmount);return;}
    setActions(current=>[...current,{id:crypto.randomUUID(),street,seat:actor,position:positions[actor],type,amount:["fold","check"].includes(type)?0:amount}]);setMessage("");
  }
  function advance(){
    if(street==="river")return;
    if(board.slice(0,boardCount).some(card=>card.length!==2)){setMessage("현재 스트리트의 보드 카드를 모두 입력하세요.");return;}
    const cards=board.slice(0,boardCount).map(card=>card.toUpperCase());
    if(new Set(cards).size!==cards.length){setMessage("같은 카드를 두 번 사용할 수 없습니다.");return;}
    setStreet(nextStreet[street]);setAmount(Math.max(1,Math.round(pot)/2));setMessage("");
  }
  function runEquity(){try{const knownBoard=board.slice(0,boardCount).filter(Boolean);const opponents=liveSeats.filter(seat=>seat!==heroSeat);setEquity(opponents.length?calculateRangeEquity(holeCards,knownBoard,opponents.map(rangeFor),5000):calculateEquity(holeCards,knownBoard,1,5000));setMessage("");}catch(error){setMessage(error instanceof Error?error.message:"Equity 계산에 실패했습니다.");}}
  function importSolver(){try{let parsed:SolverResult;try{parsed=parseSolverResult(solverText);}catch{parsed=parseTexasSolverNode(solverText,holeCards.join(""));}setSolverResult(parsed);setMessage("");}catch(error){setMessage(error instanceof Error?error.message:"Solver 결과를 읽지 못했습니다.");}}
  const actorCommitted=actor===null?0:(context.contributions.get(actor)??0);
  const toCall=Math.max(0,context.currentBet-actorCommitted);
  const estimatedEvs=equity?estimateActionEvs({equity:equity.equity,pot,toCall,betSize:amount}):[];
  const solverActions=solverResult?attachActionEvs(solverResult.actions,estimatedEvs):[];
  let solverNode:ReturnType<typeof createSolverNode>|null=null;
  try{solverNode=createSolverNode({street,heroHole:holeCards,board:board.slice(0,boardCount).filter(Boolean),pot,toCall,effectiveStack,candidateActions:allowed});}catch{solverNode=null;}
  const localSolverReady=Boolean(solverNode)&&board.slice(0,boardCount).every(card=>card.length===2)&&liveSeats.length===2&&actor===heroSeat&&streetActions.length===0;
  async function runLocalSolver(){
    if(!solverNode||!localSolverReady)return;
    runEquity();
    setSolving(true);setMessage("");
    const opponentSeat=liveSeats.find(seat=>seat!==heroSeat);
    const heroRange=toTexasSolverRange(conditionRangeOnPostflop({rangeText:heroInferredRange.text,boardCodes:board.slice(0,boardCount).filter(card=>card.length===2),actions:actions.filter(action=>action.seat===heroSeat).map(action=>action.type)}),holeCards,0.01,8);
    try{
      const response=await fetch("/api/solver",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({node:solverNode,ranges:{oop:heroRange,ip:opponentSeat===undefined?baselineRange:toTexasSolverRange(rangeFor(opponentSeat),undefined,0.01,8)},tree:{betPercent:[50],raisePercent:[60],includeAllIn:false},accuracy:10,iterations:10,threads:1})});
      const raw=await response.text();
      if(!response.ok){let reason="Solver API request failed.";try{reason=(JSON.parse(raw) as {error?:string}).error??reason;}catch{}throw new Error(reason);}
      let parsed:SolverResult;try{parsed=parseSolverResult(raw);}catch{parsed=parseTexasSolverNode(raw,holeCards.join(""));}
      setSolverText(raw);setSolverResult(parsed);
    }catch(error){setMessage(error instanceof Error?error.message:"로컬 Solver 실행에 실패했습니다.");}finally{setSolving(false);}
  }

  return <section className="postflop-builder">
    <div className="street-tabs">{(["flop","turn","river"] as const).map(value=><span key={value} className={street===value?"active":""}>{value.toUpperCase()}</span>)}</div>
    <div className="board-entry">{board.map((card,index)=><input key={index} value={card} disabled={index>=boardCount} placeholder={index<3?"--":index===3?"TURN":"RIVER"} onChange={event=>setCard(index,event.target.value)}/>)}</div>
    <div className="postflop-status"><span><small>POT</small><b>{pot.toFixed(1)} BB</b></span><span><small>TO ACT</small><b>{actor===null?"COMPLETE":positions[actor]}</b></span><span><small>CURRENT BET</small><b>{context.currentBet.toFixed(1)} BB</b></span></div>
    <div className="postflop-history">{streetActions.length?streetActions.map(action=><span key={action.id}>{action.position} <b>{labels[action.type]}</b>{action.amount>0&&` ${action.amount}BB`}</span>):<small>이 스트리트의 첫 액션을 입력하세요.</small>}</div>
    <label className="amount-field">스트리트 총 투입액<div><input type="number" min="0" max={actor===null?effectiveStack:context.remainingAtStart[actor]} step="0.5" value={amount} onChange={event=>setAmount(Number(event.target.value))}/><b>BB</b></div></label>
    <div className="action-buttons postflop-actions">{(["fold","check","bet","call","raise"] as const).map(type=><button key={type} disabled={!allowed.includes(type)} onClick={()=>add(type)}>{labels[type]}</button>)}</div>
    {message&&<p className="validation-message">{message}</p>}
    {actor===null&&street!=="river"&&<button className="advance-street" onClick={advance}>{street==="flop"?"턴":"리버"}으로 진행 →</button>}
    {actor===null&&street==="river"&&<p className="hand-complete">HAND ACTION COMPLETE</p>}
    <div className="equity-calculator"><div><span><small>HERO CARDS</small><span className="hole-inputs">{holeCards.map((card,index)=><input key={index} value={card} maxLength={2} onChange={event=>setHoleCards(current=>current.map((value,i)=>i===index?event.target.value:value))}/>)}</span></span><button onClick={runEquity}>EQUITY 계산</button></div><details className="opponent-ranges"><summary>상대 가중 레인지 <span>{liveSeats.filter(seat=>seat!==heroSeat).length}명</span></summary>{liveSeats.filter(seat=>seat!==heroSeat).map(seat=><label key={seat}>{positions[seat]} RANGE · ACTION BASELINE ({inferredRanges[seat]?.handCount??169}/169)<textarea value={rangeFor(seat)} onChange={event=>setRangeBySeat(current=>({...current,[seat]:event.target.value}))}/><button type="button" onClick={()=>setRangeBySeat(current=>{const next={...current};delete next[seat];return next;})}>RESET TO INFERRED</button></label>)}</details>{equity&&<div className="equity-result"><strong>{equity.equity}%<small>EQUITY ±{equity.marginOfError}%</small></strong><span><b>{equity.win}%</b><small>WIN</small></span><span><b>{equity.tie}%</b><small>TIE</small></span><span><b>{equity.loss}%</b><small>LOSS</small></span><em>{equity.iterations.toLocaleString()} weighted simulations · seed {equity.seed}{"availableCombos" in equity?` · ${(equity as {availableCombos:number[]}).availableCombos.join("/")} combos`:""}</em></div>}</div>
    {equity&&<div className="ev-panel"><div className="ev-head"><b>{solverResult?"SOLVER STRATEGY":"ESTIMATED EV"}</b><span className={solverResult?"solver-source":"estimate-source"}>{solverResult?(solverResult.evSource==="solver"?"SOLVER EV":"SOLVER FREQ · MODEL EV"):"NOT GTO"}</span></div>{solverResult?solverActions.map(item=><div className="ev-row" key={item.action}><span>{item.action}</span><i><b style={{width:`${item.frequency}%`}}/></i><strong>{item.frequency.toFixed(1)}% · {item.ev>=0?"+":""}{item.ev.toFixed(2)}BB<small>{item.evSource.toUpperCase()} EV</small></strong></div>):estimatedEvs.map(item=><div className="ev-row" key={item.action}><span>{item.action}</span><small>{item.assumption}</small><strong className={item.ev>=0?"positive":"negative"}>{item.ev>=0?"+":""}{item.ev.toFixed(2)} BB</strong></div>)}</div>}
    <button className="local-solver-button" disabled={!localSolverReady||solving} onClick={runLocalSolver}>{solving?"SOLVING…":"LOCAL TEXASSOLVER 실행"}</button><small className="local-solver-help">FAST PREVIEW · Heads-up · 현재 street root · Hero OOP · 상위 8개 weighted class.</small>
    <details className="solver-import"><summary>Solver 노드 내보내기 / 결과 가져오기</summary>{solverNode&&<textarea readOnly value={JSON.stringify(solverNode,null,2)}/>}<textarea value={solverText} onChange={event=>setSolverText(event.target.value)} placeholder={'정규화 결과 또는 TexasSolver native strategy node'}/><button onClick={importSolver}>전략 적용</button><small>TexasSolver native 콤보 전략과 RangeLab/OpenSpiel 정규화 JSON을 지원합니다.</small></details>
  </section>;
}
