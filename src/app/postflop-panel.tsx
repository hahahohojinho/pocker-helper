"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps } from "react";
import type { PlayerAction, Street } from "@/lib/game-state";
import type { Position } from "@/lib/preflop";
import { deriveBettingState } from "@/lib/preflop-machine";
import { postflopOrder, PostflopAction, PostflopActionType } from "@/lib/postflop-machine";
import { availablePostflopActions, buildPostflopContext, nextPostflopActor, seatsYetToRespond, validatePostflopActionV2 } from "@/lib/postflop-hand-state";
import { calculateEquity, EquityResult } from "@/lib/equity";
import { attachActionEvs, defaultFoldEquity, estimateActionEvs } from "@/lib/decision-ev";
import { estimateSubsetEquities } from "@/lib/called-equity";
import { defaultMultiwayFolds, type SubsetEquities } from "@/lib/multiway-ev";
import { createSolverNode, parseSolverResult, parseTexasSolverNode, parseTexasSolverNodeAtHistory, SolverResult } from "@/lib/solver-adapter";
import { calculateRangeEquity } from "@/lib/range-equity";
import { conditionRangeOnPostflop, ensureComboInRange, inferRangeFromPreflop, toTexasSolverRange } from "@/lib/range-model";
import { isWasmSolverSupported, runWasmSolve } from "@/lib/wasm-solver/client";
import { buildMultiwaySolveRequest, MULTIWAY_MAX_PLAYERS, streetStartPotLayers } from "@/lib/wasm-solver/multiway-request";
import { NativeSolverUnavailableError, runNativeMultiwaySolve, runNativeSolve } from "@/lib/wasm-solver/native-client";
import { buildWasmSolveRequest } from "@/lib/wasm-solver/request";
import type { TableSize } from "@/lib/preflop-packs";
import { loadIterationCost, recordIterationCost } from "@/lib/wasm-solver/cost-model";
import { timed } from "@/lib/timing";
import { exploitabilityLevel, getSolverPreset } from "@/lib/solver-presets";
import { buildSolverTree } from "@/lib/solver-tree";
import HandRecorderPanel from "./profiling/hand-recorder-panel";
import PostflopExploitCard from "./exploit/postflop-exploit-card";
import FlopLibraryCard from "./flop-library/flop-library-card";
import { exploitRange, MAX_RANGE_TEXT } from "@/lib/exploit/postflop-exploits";
import type { StatTotals } from "@/lib/profiling/classify";
import type { ProfileTableSize } from "@/lib/profiling/hand-record";

/** Recorder settings owned by the table helper; the panel supplies the hand it holds (board, actions, cards). */
export type RecorderProps=Omit<ComponentProps<typeof HandRecorderPanel>,"positions"|"stacks"|"heroSeat"|"heroCards"|"preflopActions"|"postflopActions"|"board">;

const labels:Record<PostflopActionType,string>={fold:"Fold",check:"Check",bet:"Bet",call:"Call",raise:"Raise"};
const nextStreet={flop:"turn",turn:"river"} as const;
// About +-0.65%p Monte Carlo error; a 7-way run of both takes roughly 0.2s on a desktop CPU.
const EQUITY_ITERATIONS=20_000;
// The worker is terminated after this; a single-threaded flop solve with ~1000-combo ranges can take over a minute.
const WASM_SOLVE_TIMEOUT_MS=240_000;
const subscribeNever=()=>()=>{};
/** The answer target for a decision; slower solves get a hint to use the native solver. */
const ANSWER_TARGET_MS=10_000;
const MIN_COST_SAMPLE_ITERATIONS=3;
/** localStorage can throw (blocked site data, previews); the cost model then uses its defaults. */
function browserStorage(){try{return window.localStorage;}catch{return undefined;}}
const CALLED_EQUITY_ITERATIONS=10_000;
// Per caller subset; up to nine subsets keep a 7-way estimate around 0.2s.
const MULTIWAY_SUBSET_ITERATIONS=5000;
/** Postflop streets in dealing order; a fold on an earlier street removes the seat from later streets. */
const STREET_ORDER=["flop","turn","river"] as const;
const baselineRange="AA,KK,QQ,JJ,TT,99,88,77,66,55,44,33,22,AKs,AQs,AJs,ATs,A9s,A8s,A7s,A6s,A5s,A4s,A3s,A2s,KQs,KJs,KTs,QJs,QTs,JTs,T9s,98s,87s,76s,65s,54s,AKo,AQo,AJo,KQo";

export default function PostflopPanel({positions,preflopActions,stacks,heroSeat,recorder,exploit}:{positions:Position[];preflopActions:PlayerAction[];stacks:number[];heroSeat:number;recorder?:RecorderProps;exploit?:{tableSize:ProfileTableSize;statsBySeat:readonly (StatTotals|undefined)[]}}){
  const preflop=deriveBettingState(preflopActions,positions,stacks);
  // Solved preflop packs exist per table size; the seat count tells which one applies.
  const tableSize:TableSize|undefined=positions.length===6||positions.length===8?positions.length:undefined;
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
  const [calledEquity,setCalledEquity]=useState<{value:SubsetEquities;key:string}|null>(null);
  const [solverText,setSolverText]=useState("");
  const [solverResult,setSolverResult]=useState<SolverResult|null>(null);
  const [solving,setSolving]=useState(false);
  const [rangeBySeat,setRangeBySeat]=useState<Record<number,string>>({});
  const [solverCapability,setSolverCapability]=useState<{backend:"texassolver"|"dcfr"|"counterfactual";maxPlayers:number;nativeJson:boolean;multiwayStreets:string[]}>({backend:"texassolver",maxPlayers:2,nativeJson:false,multiwayStreets:[]});
  const wasmSupported=useSyncExternalStore(subscribeNever,isWasmSolverSupported,()=>false);
  const wasmSolveRef=useRef<AbortController|null>(null);
  const [solveProgress,setSolveProgress]=useState<{done:number;total:number}|null>(null);
  const [solveMode,setSolveMode]=useState<"native"|"wasm"|null>(null);
  useEffect(()=>()=>wasmSolveRef.current?.abort(),[]);
  useEffect(()=>{const controller=new AbortController();fetch("/api/solver",{signal:controller.signal,cache:"no-store"}).then(response=>response.ok?response.json():Promise.reject()).then(value=>{if(value&&["texassolver","dcfr","counterfactual"].includes(value.backend)&&Number.isInteger(value.maxPlayers))setSolverCapability({backend:value.backend,maxPlayers:value.maxPlayers,nativeJson:value.nativeJson===true,multiwayStreets:value.nativeMultiway&&value.nativeMultiway.maxPlayers>=MULTIWAY_MAX_PLAYERS&&Array.isArray(value.nativeMultiway.streets)?value.nativeMultiway.streets.filter((item:unknown)=>typeof item==="string"):[]});}).catch(()=>{});return()=>controller.abort();},[]);
  const inferredRanges=Object.fromEntries(activeSeats.filter(seat=>seat!==heroSeat).map(seat=>[seat,inferRangeFromPreflop({actions:preflopActions,seat,position:positions[seat],stack:stacks[seat],tableSize})]));
  const heroInferredRange=inferRangeFromPreflop({actions:preflopActions,seat:heroSeat,position:positions[heroSeat],stack:stacks[heroSeat],tableSize});
  const rangeFor=(seat:number)=>rangeBySeat[seat]??conditionRangeOnPostflop({rangeText:inferredRanges[seat]?.text??baselineRange,boardCodes:board.slice(0,boardCount).filter(card=>card.length===2),actions:actions.filter(action=>action.seat===seat).map(action=>action.type)});
  const streetActions=useMemo(()=>actions.filter(action=>action.street===street),[actions,street]);
  const context=buildPostflopContext({actions,street,seats:activeSeats,initialRemaining,initialPot:preflop.pot});
  const actor=nextPostflopActor(context,order);
  const allowed=actor===null?[]:availablePostflopActions(context,actor);
  const pot=context.pot;
  const liveSeats=activeSeats.filter(seat=>!context.foldedSeats.has(seat));
  const effectiveStack=Math.min(...liveSeats.map(seat=>context.remainingAtStart[seat]??0));
  // Seats that started this street; folds on the current street are part of the solver history, not removed seats.
  const streetIndex=STREET_ORDER.indexOf(street);
  const streetStartSeats=activeSeats.filter(seat=>!actions.some(action=>action.seat===seat&&action.type==="fold"&&STREET_ORDER.indexOf(action.street as typeof street)<streetIndex));
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
  // Model EV is always from Hero's seat, so it uses Hero's commitments rather than the next actor's.
  const heroCommitted=context.contributions.get(heroSeat)??0;
  const heroToCall=Math.max(0,context.currentBet-heroCommitted);
  const opponentSeats=liveSeats.filter(seat=>seat!==heroSeat);
  const maxCommitment=Math.min(context.remainingAtStart[heroSeat]??0,Math.max(0,...opponentSeats.map(seat=>context.remainingAtStart[seat]??0)));
  const knownBoard=board.slice(0,boardCount).filter(Boolean);
  const modelSizing={pot,toCall:heroToCall,betSize:amount,heroCommitted,maxCommitment};
  // Multiway: each opponent who can still fold folds independently; all-in opponents always see the showdown.
  const foldable=opponentSeats.map(seat=>!context.allInSeats.has(seat));
  const callCaps=opponentSeats.map(seat=>Math.max(0,(context.remainingAtStart[seat]??0)-context.currentBet));
  // Opponents who have not matched the current bet pay that first when they call a raise.
  const owed=opponentSeats.map(seat=>Math.max(0,Math.min(context.currentBet,context.remainingAtStart[seat]??0)-(context.contributions.get(seat)??0)));
  // Any input that changes equity when called invalidates a previous calculation.
  const calledEquityKey=JSON.stringify([holeCards,knownBoard,opponentSeats.map(rangeFor),modelSizing,foldable]);
  function runEquity(){
    try{
      setEquity(opponentSeats.length?calculateRangeEquity(holeCards,knownBoard,opponentSeats.map(rangeFor),EQUITY_ITERATIONS):calculateEquity(holeCards,knownBoard,1,EQUITY_ITERATIONS));
      setMessage("");
    }catch(error){setEquity(null);setCalledEquity(null);setMessage(error instanceof Error?error.message:"Equity 계산에 실패했습니다.");return;}
    try{
      const foldShare=defaultFoldEquity(modelSizing);
      const folds=defaultMultiwayFolds(foldShare,foldable);
      const iterations=opponentSeats.length>1?MULTIWAY_SUBSET_ITERATIONS:CALLED_EQUITY_ITERATIONS;
      const value=opponentSeats.length&&foldShare>0&&foldShare<1?estimateSubsetEquities(holeCards,knownBoard,opponentSeats.map(rangeFor),folds,iterations):null;
      setCalledEquity(value===null?null:{value,key:calledEquityKey});
    }catch(error){setCalledEquity(null);setMessage(error instanceof Error?`콜 레인지 Equity 계산 실패: ${error.message}`:"콜 레인지 Equity 계산에 실패했습니다.");}
  }
  function importSolver(){try{let parsed:SolverResult;try{parsed=parseSolverResult(solverText);}catch{parsed=parseTexasSolverNode(solverText,holeCards.join(""));}setSolverResult(parsed);setMessage("");}catch(error){setMessage(error instanceof Error?error.message:"Solver 결과를 읽지 못했습니다.");}}
  const actorCommitted=actor===null?0:(context.contributions.get(actor)??0);
  const toCall=Math.max(0,context.currentBet-actorCommitted);
  const freshCalledEquity=calledEquity?.key===calledEquityKey?calledEquity.value:undefined;
  // Exploit c-bet: flop, hero raised last preflop, no bet yet. Ranges the user edited are used as they are.
  const heroWasAggressor=preflopActions.findLast(action=>["open","3bet","4bet","5bet"].includes(action.type))?.seat===heroSeat;
  const exploitSpot=exploit&&street==="flop"&&actor===heroSeat&&heroWasAggressor&&context.currentBet===0&&knownBoard.length===3&&opponentSeats.length>0&&holeCards.every(card=>card.length===2);
  const exploitInputs=exploitSpot?{seats:opponentSeats,board:knownBoard,statsBySeat:exploit.statsBySeat,tableSize:exploit.tableSize}:null;
  const exploitInputsKey=JSON.stringify([exploitInputs?.seats,exploitInputs?.board,opponentSeats.map(seat=>rangeBySeat[seat]?.length??0),actions.length,preflopActions.length,stacks]);
  // Scoring every combo on the board is too slow to repeat on every render (e.g. while typing).
  const exploitRanges=useMemo(()=>exploitInputs?exploitInputs.seats.map(seat=>{
    if(rangeBySeat[seat])return {seat,rangeText:rangeBySeat[seat],usage:[]};
    try{
      const locked=exploitRange({rangeText:inferredRanges[seat]?.text??baselineRange,seat,position:positions[seat],preflop:preflopActions,totals:exploitInputs.statsBySeat[seat],tableSize:exploitInputs.tableSize});
      return {seat,rangeText:conditionRangeOnPostflop({rangeText:locked.rangeText,boardCodes:exploitInputs.board,actions:actions.filter(action=>action.seat===seat).map(action=>action.type)}),usage:locked.usage};
    }catch{return {seat,rangeText:rangeFor(seat),usage:[]};}
  // The key covers every input that changes these ranges (seats, board, edits, action counts).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }):[],[exploitInputsKey,exploitInputs?.statsBySeat]);
  let estimatedEvs:ReturnType<typeof estimateActionEvs>=[];
  // A model failure must not take the panel down; the EV list is just left empty.
  try{if(equity&&actor===heroSeat)estimatedEvs=estimateActionEvs({...modelSizing,equity:equity.equity,calledEquities:freshCalledEquity,opponents:opponentSeats.length,foldable,callCaps,owed,playersBehind:seatsYetToRespond(context,heroSeat,liveSeats).length});}
  catch(error){console.error("Model EV failed",error);}
  const solverActions=solverResult?attachActionEvs(solverResult.actions,estimatedEvs):[];
  const multiwayResult=solverResult?.source==="multiway-native";
  const convergence=exploitabilityLevel(multiwayResult?solverResult?.maxBrGain:solverResult?.exploitability);
  let solverNode:ReturnType<typeof createSolverNode>|null=null;
  try{solverNode=createSolverNode({street,heroHole:holeCards,board:board.slice(0,boardCount).filter(Boolean),pot,toCall,effectiveStack,candidateActions:allowed});}catch{solverNode=null;}
  let localRootNode:ReturnType<typeof createSolverNode>|null=null;
  try{localRootNode=createSolverNode({street,heroHole:holeCards,board:board.slice(0,boardCount).filter(Boolean),pot:context.potBefore,toCall:0,effectiveStack:Math.min(...liveSeats.map(seat=>context.remainingAtStart[seat]??0)),candidateActions:["check","bet"]});}catch{localRootNode=null;}
  // Heads-up spots use the DCFR solver on every street and node: natively on the server when it is advertised (multi-
  // threaded), otherwise in the browser. Multiway spots still need a server backend.
  const preferNative=solverCapability.nativeJson;
  const useDcfr=streetStartSeats.length===2&&(preferNative||wasmSupported);
  // Three players on the turn or river: the adapter's native multiway mode, when it advertises the street. Players all-in
  // from an earlier street are included with a zero stack and the side pots they cannot win.
  // With only Hero left able to bet there is nothing to solve (the tree only checks), so that spot keeps the model.
  const useMultiway=!useDcfr&&preferNative&&streetStartSeats.length===MULTIWAY_MAX_PLAYERS&&solverCapability.multiwayStreets.includes(street)&&streetStartSeats.filter(seat=>(context.remainingAtStart[seat]??0)>0).length>=2;
  const solverBackend=useDcfr?(preferNative?"native":"wasm"):useMultiway?"multiway":solverCapability.backend;
  const solverReady=Boolean(solverBackend==="counterfactual"?solverNode:localRootNode)&&board.slice(0,boardCount).every(card=>card.length===2)&&liveSeats.length>=2&&(useDcfr||useMultiway||liveSeats.length<=solverCapability.maxPlayers)&&actor===heroSeat;
  /**
   * Range at the start of this street: a user-edited range is used as entered; otherwise the preflop inference is
   * conditioned on earlier postflop streets only (the current board stands in for the earlier boards).
   */
  function streetStartRange(seat:number){
    const edited=rangeBySeat[seat];
    const preflopRange=seat===heroSeat?heroInferredRange.text:inferredRanges[seat]?.text??baselineRange;
    const earlier=actions.filter(action=>action.seat===seat&&action.street!==street).map(action=>action.type);
    const range=edited??conditionRangeOnPostflop({rangeText:preflopRange,boardCodes:knownBoard,actions:earlier});
    return seat===heroSeat?ensureComboInRange(range,holeCards):range;
  }
  function dcfrRequest(backend:"native"|"wasm"){
    const oopSeat=order.find(seat=>streetStartSeats.includes(seat))!;const ipSeat=streetStartSeats.find(seat=>seat!==oopSeat)!;
    const preset=getSolverPreset(backend,street);
    return buildWasmSolveRequest({
      board:knownBoard,heroHole:holeCards,oopRange:streetStartRange(oopSeat),ipRange:streetStartRange(ipSeat),
      pot:context.potBefore,stacks:{oop:context.remainingAtStart[oopSeat]??0,ip:context.remainingAtStart[ipSeat]??0},
      history:streetActions.map(action=>({role:action.seat===oopSeat?"oop":"ip",action:action.type,amount:action.amount})),
      iterations:preset.iterations,betPercent:preset.tree.betPercent,raisePercent:preset.tree.raisePercent,timeBudgetMs:preset.timeBudgetMs,
      ...(backend==="wasm"?{iterationCostNs:loadIterationCost(browserStorage(),street)}:{}),
    });
  }
  function multiwayRequest(){
    // `order` skips seats all-in preflop; the solver needs every seat still in the hand, in action order.
    const seats=postflopOrder(positions,preflop.foldedSeats).filter(seat=>streetStartSeats.includes(seat));
    const preset=getSolverPreset("multiway",street);
    const committed=new Map(positions.map((_,seat)=>[seat,Math.max(0,stacks[seat]-(context.remainingAtStart[seat]??0))]));
    return buildMultiwaySolveRequest({
      board:knownBoard,heroHole:holeCards,heroIndex:seats.indexOf(heroSeat),
      players:seats.map(seat=>({range:streetStartRange(seat),stack:context.remainingAtStart[seat]??0})),
      pot:context.potBefore,potLayers:streetStartPotLayers({committed,players:seats,pot:context.potBefore}),
      history:streetActions.map(action=>({player:seats.indexOf(action.seat),action:action.type,amount:action.amount})),
      iterations:preset.iterations,betPercent:preset.tree.betPercent,raisePercent:preset.tree.raisePercent,timeBudgetMs:preset.timeBudgetMs,
    });
  }
  // The flop library answers the same request the native solver would get, so it only matches identical spots.
  let libraryRequest:ReturnType<typeof dcfrRequest>|null=null;
  if(street==="flop"&&streetStartSeats.length===2&&actor===heroSeat&&knownBoard.length===3&&holeCards.every(card=>card.length===2)){
    try{libraryRequest=dcfrRequest("native");}catch{libraryRequest=null;}
  }
  /** Native first when advertised; falls back to the browser when the server cannot run it. */
  async function solveDcfr(signal:AbortSignal){
    if(useMultiway){
      setSolveMode("native");
      return runNativeMultiwaySolve(multiwayRequest(),{signal});
    }
    if(preferNative){
      setSolveMode("native");
      try{return await runNativeSolve(dcfrRequest("native"),{signal});}
      catch(error){if(!(error instanceof NativeSolverUnavailableError)||!wasmSupported)throw error;}
    }
    setSolveMode("wasm");
    const {value:raw,elapsedMs}=await timed(()=>runWasmSolve(dcfrRequest("wasm"),{timeoutMs:WASM_SOLVE_TIMEOUT_MS,signal,onProgress:(done,total)=>setSolveProgress({done,total})}));
    // Learn this machine's wasm speed so the next solve plans its iterations within the budget.
    // Only budget-limited solves with enough iterations reflect per-iteration cost; short capped solves are dominated
    // by worker start-up and tree building.
    const {workUnits,iterations,stoppedBy}=JSON.parse(raw) as {workUnits?:number;iterations?:number;stoppedBy?:string};
    if(workUnits&&iterations&&iterations>MIN_COST_SAMPLE_ITERATIONS&&stoppedBy==="deadline")recordIterationCost(browserStorage(),street,{elapsedMs,workUnits,iterations});
    return raw;
  }
  async function runWasmSolver(){
    wasmSolveRef.current?.abort();
    const controller=new AbortController();wasmSolveRef.current=controller;
    try{
      // End-to-end time as the user experiences it, including range building and transport.
      const {value:raw,elapsedMs}=await timed(()=>solveDcfr(controller.signal));
      setSolverText(raw);setSolverResult({...parseSolverResult(raw),elapsedMs});
      if(elapsedMs>ANSWER_TARGET_MS&&!preferNative)setMessage(`브라우저 Solver가 ${(elapsedMs/1000).toFixed(1)}초 걸렸습니다. DCFR_ADAPTER_PATH로 네이티브 Solver를 켜면 10초 안에 답합니다.`);
      const note=(JSON.parse(raw) as {note?:string}).note;
      if(note)setMessage(note);
    }catch(error){if(!controller.signal.aborted)setMessage(error instanceof Error?error.message:"브라우저 Solver 실행에 실패했습니다.");}
    finally{if(wasmSolveRef.current===controller){wasmSolveRef.current=null;setSolving(false);setSolveProgress(null);setSolveMode(null);}}
  }
  function cancelWasmSolve(){
    if(!wasmSolveRef.current)return;
    wasmSolveRef.current.abort();
    setMessage("Solver 실행을 취소했습니다.");
  }
  // The last iteration is followed by an exploitability pass, so a full bar still means "finishing".
  const solvingLabel=solveMode==="native"?"SOLVING (NATIVE)…":!solveProgress?"SOLVING…":solveProgress.done>=solveProgress.total?"마무리 중…":`SOLVING ${solveProgress.done}/${solveProgress.total}`;
  async function runLocalSolver(){
    if(useDcfr||useMultiway){
      if(!solverReady||actor===null)return;
      runEquity();setSolving(true);setMessage("");
      await runWasmSolver();
      return;
    }
    const requestNode=solverCapability.backend==="counterfactual"?solverNode:localRootNode;
    if(!requestNode||!solverReady||actor===null)return;
    runEquity();
    setSolving(true);setMessage("");
    const preset=getSolverPreset(solverCapability.backend,street);
    const oopSeat=order.find(seat=>liveSeats.includes(seat))!;const ipSeat=liveSeats.find(seat=>seat!==oopSeat)!;
    const seatRange=(seat:number)=>toTexasSolverRange(seat===heroSeat?heroInferredRange.text:inferredRanges[seat]?.text??baselineRange,seat===heroSeat?holeCards:undefined,0.01,preset.maxClasses,requestNode.board);
    const actionHistory=streetActions.map(action=>({action:action.type,amount:action.amount}));
    try{
      // Local TexasSolver solves from the street root, so the tree must contain the sizes already seen this street.
      const tree=solverCapability.backend==="texassolver"?buildSolverTree(preset.tree,actionHistory,requestNode.pot,requestNode.effectiveStack):preset.tree;
      const players=liveSeats.map(seat=>({seat,range:seatRange(seat),stack:context.remainingAtStart[seat]??0}));
      const response=await fetch("/api/solver",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({node:requestNode,ranges:{oop:seatRange(oopSeat),ip:seatRange(ipSeat)},tree,accuracy:preset.accuracy,iterations:preset.iterations,threads:preset.threads,useIsomorphism:preset.useIsomorphism,actionHistory,players,actorSeat:actor})});
      const raw=await response.text();
      if(!response.ok){let reason="Solver API request failed.";try{reason=(JSON.parse(raw) as {error?:string}).error??reason;}catch{}throw new Error(reason);}
      let parsed:SolverResult;try{parsed=parseSolverResult(raw);}catch{parsed=actionHistory.length?parseTexasSolverNodeAtHistory(raw,holeCards.join(""),actionHistory,{allInAmount:requestNode.effectiveStack}):parseTexasSolverNode(raw,holeCards.join(""));}
      const exploitabilityHeader=response.headers.get("x-solver-exploitability")?.trim();
      const headerExploitability=exploitabilityHeader?Number(exploitabilityHeader):Number.NaN;
      if(parsed.exploitability===undefined&&Number.isFinite(headerExploitability))parsed={...parsed,exploitability:headerExploitability};
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
    <div className="equity-calculator"><div><span><small>HERO CARDS</small><span className="hole-inputs">{holeCards.map((card,index)=><input key={index} value={card} maxLength={2} onChange={event=>setHoleCards(current=>current.map((value,i)=>i===index?event.target.value:value))}/>)}</span></span><button onClick={runEquity}>EQUITY 계산</button></div><details className="opponent-ranges"><summary>상대 가중 레인지 <span>{liveSeats.filter(seat=>seat!==heroSeat).length}명</span></summary>{liveSeats.filter(seat=>seat!==heroSeat).map(seat=><label key={seat}>{positions[seat]} RANGE · ACTION BASELINE ({inferredRanges[seat]?.handCount??169}/169)<textarea maxLength={MAX_RANGE_TEXT} value={rangeFor(seat)} onChange={event=>setRangeBySeat(current=>({...current,[seat]:event.target.value}))}/><button type="button" onClick={()=>setRangeBySeat(current=>{const next={...current};delete next[seat];return next;})}>RESET TO INFERRED</button></label>)}</details>{equity&&<div className="equity-result"><strong>{equity.equity}%<small>EQUITY ±{equity.marginOfError}%</small></strong><span><b>{equity.win}%</b><small>WIN</small></span><span><b>{equity.tie}%</b><small>TIE</small></span><span><b>{equity.loss}%</b><small>LOSS</small></span><em>{equity.iterations.toLocaleString()} weighted simulations · seed {equity.seed}{"availableCombos" in equity?` · ${(equity as {availableCombos:number[]}).availableCombos.join("/")} combos`:""}</em></div>}</div>
    {exploitSpot&&exploit&&<PostflopExploitCard heroCards={[holeCards[0],holeCards[1]]} board={knownBoard} pot={pot} maxCommitment={maxCommitment} rangeUsage={exploitRanges.flatMap(item=>item.usage)} inputKey={JSON.stringify([holeCards,knownBoard,pot,maxCommitment,exploitInputsKey,opponentSeats.map(seat=>exploit.statsBySeat[seat]??null)])} opponents={exploitRanges.map(item=>({position:positions[item.seat],rangeText:item.rangeText,totals:exploit.statsBySeat[item.seat],allIn:(context.remainingAtStart[item.seat]??0)<=0,stack:context.remainingAtStart[item.seat]??0}))}/>}
    {equity&&<div className="ev-panel"><div className="ev-head"><b>{solverResult?"SOLVER STRATEGY":"ESTIMATED EV"}</b><span className={solverResult?"solver-source":"estimate-source"}>{solverResult?(solverResult.evSource==="solver"?(multiwayResult?(solverResult.riverModel==="checkdown"?"SOLVER EV · 3-WAY CFR · 리버 체크다운 근사":"SOLVER EV · 3-WAY CFR"):"SOLVER EV"):"SOLVER FREQ · MODEL EV"):"NOT GTO"}</span>{solverResult?.elapsedMs!==undefined&&<span className={`solve-timing${solverResult.elapsedMs>ANSWER_TARGET_MS?" solve-timing-slow":""}`}>{(solverResult.elapsedMs/1000).toFixed(1)}s{solverResult.iterations!==undefined?` · ${solverResult.iterations} iter`:""}{solverResult.stoppedBy==="deadline"?" · 시간 제한":""}{solverResult.elapsedMs>ANSWER_TARGET_MS?" · 10초 초과":""}</span>}{solverResult&&<span className={`convergence convergence-${convergence}`} title={multiwayResult?"3인 CFR은 내쉬 균형을 보장하지 않습니다. 다른 두 명의 전략을 고정했을 때 한 명이 전략을 바꿔 얻을 수 있는 최대 이득입니다.":undefined}>{multiwayResult?(solverResult.maxBrGain===undefined?"수렴도 미확인":`MAX BR GAIN ${solverResult.maxBrGain.toFixed(2)}% POT`):solverResult.exploitability===undefined?"수렴도 미확인":`EXPLOIT ${solverResult.exploitability.toFixed(2)}% POT`}{convergence==="warn"&&" · 수렴 부족"}{convergence==="bad"&&" · 미수렴, 신뢰 불가"}</span>}</div>{solverResult?solverActions.map(item=><div className="ev-row" key={item.action}><span>{item.action}</span><i><b style={{width:`${item.frequency}%`}}/></i><strong>{item.frequency.toFixed(1)}% · {item.ev>=0?"+":""}{item.ev.toFixed(2)}BB<small>{item.evSource.toUpperCase()} EV</small></strong></div>):estimatedEvs.map(item=><div className="ev-row" key={item.action}><span>{item.action}</span><small>{item.assumption}</small><strong className={item.ev>=0?"positive":"negative"}>{item.ev>=0?"+":""}{item.ev.toFixed(2)} BB</strong></div>)}{!solverResult&&!estimatedEvs.length&&<small className="ev-note">모델 EV는 Hero 차례에만 표시합니다.</small>}</div>}
    <FlopLibraryCard request={libraryRequest} requestKey={JSON.stringify(libraryRequest)} onApply={result=>{setSolverResult(result);setSolverText("");}}/>
    <button className="local-solver-button" disabled={!solverReady||solving} onClick={runLocalSolver}>{solving?solvingLabel:useMultiway?"네이티브 3-WAY SOLVER 실행":useDcfr?(preferNative?"네이티브 SOLVER 실행":"브라우저 SOLVER 실행"):solverCapability.backend==="counterfactual"?"COUNTERFACTUAL SOLVER 실행":solverCapability.backend==="dcfr"?"LOCAL DCFR EV 실행":"LOCAL TEXASSOLVER 실행"}</button>{solving&&(useDcfr||useMultiway)&&<button type="button" className="solver-cancel-button" onClick={cancelWasmSolve}>취소</button>}<small className="local-solver-help">{useMultiway?<>NATIVE 3-WAY CFR · {street==="turn"?"턴(리버는 체크다운 가정, EV 근사)":"리버"} · 모든 노드 · 사이드팟 · 내쉬 균형 보장 없음 · {getSolverPreset("multiway",street).iterations} iterations</>:useDcfr?<>{preferNative?`NATIVE DCFR · 멀티스레드 · Heads-up · 모든 노드 · ${getSolverPreset("native",street).iterations} iterations · `:`IN-BROWSER DCFR · Heads-up · 모든 노드 · ${getSolverPreset("wasm",street).iterations} iterations${street==="flop"?" · flop은 1~2분 소요, 수렴도 확인":""} · `}<a href="/solver/THIRD-PARTY-LICENSES.txt" target="_blank" rel="noreferrer">라이선스</a></>:<>BOUNDED SOLVE · {solverCapability.backend==="counterfactual"?`외부 backend · 최대 ${solverCapability.maxPlayers}명`:solverCapability.backend==="dcfr"?"Heads-up · street root 및 중간 액션 노드 · Hero OOP/IP · solver counterfactual EV":"Heads-up · street root 및 중간 액션 노드 · Hero OOP/IP"} · 전체 weighted class · 반복 상한 내 조기 종료.</>}</small>
    {streetStartSeats.length>2&&!useMultiway&&solverCapability.backend!=="counterfactual"&&<p className="local-solver-help">멀티웨이는 턴/리버 3인(네이티브 Solver)만 로컬 Solver가 풉니다. 위 EV는 MODEL 근사입니다.</p>}
    <details className="solver-import"><summary>Solver 노드 내보내기 / 결과 가져오기</summary>{solverNode&&<textarea readOnly value={JSON.stringify(solverNode,null,2)}/>}<textarea value={solverText} onChange={event=>setSolverText(event.target.value)} placeholder={'정규화 결과 또는 TexasSolver native strategy node'}/><button onClick={importSolver}>전략 적용</button><small>TexasSolver native 콤보 전략과 RangeLab/OpenSpiel 정규화 JSON을 지원합니다.</small></details>
    {recorder&&<HandRecorderPanel {...recorder} positions={positions} stacks={stacks} heroSeat={heroSeat} heroCards={holeCards} preflopActions={preflopActions} postflopActions={actions} board={board}/>}
  </section>;
}
