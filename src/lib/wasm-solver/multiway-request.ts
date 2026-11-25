import type { PostflopActionType } from "../postflop-machine";
import { calculatePotLayers } from "../pots";
import { CHIPS_PER_BB, MAX_RAISES, cardCodes, fraction, mergeSizes, toChips, type Fraction, type WasmHistoryAction } from "./request";

/** The native multiway solver supports this many players on the turn (river checked down) and river. */
export const MULTIWAY_MAX_PLAYERS=3;

export interface MultiwayHistoryStep { player:number;action:PostflopActionType;amount:number; }
export interface MultiwaySolveInput {
  board:string[];heroHole:string[];
  /** Hero's index in `players`. */
  heroIndex:number;
  /** Players live at the start of the street, in postflop action order; ranges as text, stacks in BB at street start. */
  players:{range:string;stack:number}[];
  /** Pot at the start of the street, in BB. */
  pot:number;
  /**
   * That pot split into main and side pots (BB; `eligible` indexes `players`), needed when a player went all-in on an
   * earlier street. Omitted: one pot everyone can win.
   */
  potLayers?:{amount:number;eligible:number[]}[];
  /** Current-street actions; `player` indexes `players`, `amount` is the actor's street-total commitment in BB. */
  history:MultiwayHistoryStep[];
  iterations:number;betPercent:number[];raisePercent:number[];timeBudgetMs?:number;
}
export interface MultiwaySolveRequest {
  board:string;hero:string;heroSeat:number;players:{range:string;stack:number}[];pot:number;potLayers?:{amount:number;eligible:number[]}[];iterations:number;
  betSizes:Fraction[][];maxRaises:number;history:WasmHistoryAction[];timeBudgetMs?:number;
}

interface Encoding { history:WasmHistoryAction[];sizesByDepth:Fraction[][];aggressions:number; }

/**
 * Same sizing as the heads-up encoder, with per-player bets: a bet is `fraction * (pot + street bets)`; a raise adds
 * `fraction * (pot + street bets + to call)` on top of the largest bet. A call or bet that needs the whole remaining
 * stack is the all-in branch.
 */
function encodeHistory(input:MultiwaySolveInput,pot:number):Encoding{
  const stacks=input.players.map(player=>toChips(player.stack));
  const bets=stacks.map(()=>0);
  const history:WasmHistoryAction[]=[];const sizesByDepth:Fraction[][]=[];let aggressions=0;
  for(const step of input.history){
    if(!Number.isInteger(step.player)||step.player<0||step.player>=stacks.length)throw new Error("Multiway history names an unknown player.");
    const maxBet=Math.max(...bets);
    const toCall=maxBet-bets[step.player];
    const remaining=stacks[step.player]-bets[step.player];
    if(step.action==="check"||step.action==="fold"){history.push({action:step.action});continue;}
    if(step.action==="call"){
      history.push({action:toCall>=remaining?"allin":"call"});
      bets[step.player]=Math.min(maxBet,stacks[step.player]);
      continue;
    }
    const amount=toChips(step.amount);
    const tooManyRaises=()=>new Error(`The multiway solver supports at most ${MAX_RAISES-1} bets and raises before the decision.`);
    if(amount>=stacks[step.player]){
      // Only an all-in above the largest bet is an aggression in the solver tree; a shorter one is a call for less.
      if(stacks[step.player]>maxBet){if(aggressions+1>=MAX_RAISES)throw tooManyRaises();aggressions++;}
      history.push({action:"allin"});bets[step.player]=stacks[step.player];continue;
    }
    if(aggressions+1>=MAX_RAISES)throw tooManyRaises();
    const depth=aggressions;aggressions++;
    const currentPot=pot+bets.reduce((sum,bet)=>sum+bet,0);
    const size=toCall>0?fraction(amount-maxBet,currentPot+toCall):fraction(amount,currentPot);
    if(size[0]<=0)throw new Error(`Observed ${step.action} ${step.amount}BB does not exceed the current bet.`);
    // The tree drops raises whose increment is below the bet faced minus one chip, as dcfr-solver does.
    if(toCall>0&&amount-maxBet<maxBet-1)throw new Error(`${step.amount}BB 레이즈는 멀티웨이 Solver 트리의 최소 레이즈(증분 >= 직전 베팅 ${maxBet/CHIPS_PER_BB}BB)보다 작아 풀 수 없습니다.`);
    history.push({action:toCall>0?"raise":"bet",size});
    sizesByDepth[depth]=[...(sizesByDepth[depth]??[]),size];
    bets[step.player]=amount;
  }
  return {history,sizesByDepth,aggressions};
}

/** Layers in chips; rounding goes to the main pot so the layers add up to the pot exactly. */
function chipLayers(layers:MultiwaySolveInput["potLayers"],pot:number,players:number){
  if(!layers||layers.length<=1)return undefined;
  if(layers.some(layer=>!layer.eligible.length||layer.eligible.some(index=>!Number.isInteger(index)||index<0||index>=players)))throw new Error("Pot layers must name the players who can win them.");
  const chips=layers.map(layer=>({amount:toChips(layer.amount),eligible:[...new Set(layer.eligible)]}));
  chips[0]={...chips[0],amount:chips[0].amount+pot-chips.reduce((sum,layer)=>sum+layer.amount,0)};
  if(chips.some(layer=>!(layer.amount>0)))throw new Error("Pot layers must be positive.");
  return chips;
}

/**
 * Splits the street-start pot by what each seat put in on earlier streets, so a player already all-in only contests
 * the layers they paid into. `committed` covers every seat (folded ones are dead money); `players` are the seats
 * still in, in solver order. Chips outside the contributions (antes) go to the main pot; a layer nobody still in can
 * win (only folded contributors) merges into the layer below. Returns undefined when there is a single pot.
 */
export function streetStartPotLayers(input:{committed:ReadonlyMap<number,number>;players:number[];pot:number}){
  // Contributions come from BB subtraction; snapping to chips keeps equal amounts equal.
  const committed=new Map([...input.committed].map(([seat,amount])=>[seat,toChips(amount)/CHIPS_PER_BB]));
  const folded=new Set([...committed.keys()].filter(seat=>!input.players.includes(seat)));
  const merged:{amount:number;eligible:number[]}[]=[];
  for(const layer of calculatePotLayers(committed,folded)){
    const eligible=layer.eligibleSeats.map(seat=>input.players.indexOf(seat)).sort((left,right)=>left-right);
    const last=merged.at(-1);
    // Levels from folded blinds and bets share their players with the layer below, so they are one pot.
    if(last&&(!eligible.length||last.eligible.join()===eligible.join()))merged[merged.length-1]={...last,amount:last.amount+layer.amount};
    else merged.push({amount:layer.amount,eligible});
  }
  const layers=merged.filter(layer=>layer.eligible.length);
  if(layers.length<=1)return undefined;
  const missing=input.pot-layers.reduce((sum,layer)=>sum+layer.amount,0);
  // Chips beyond the contributions are dead money for the main pot; contributions above the pot mean bad input.
  if(missing<-0.01)throw new Error("Earlier-street contributions exceed the pot.");
  layers[0]={...layers[0],amount:layers[0].amount+missing};
  return layers;
}

export function buildMultiwaySolveRequest(input:MultiwaySolveInput):MultiwaySolveRequest{
  if(input.players.length<2||input.players.length>MULTIWAY_MAX_PLAYERS)throw new Error(`The multiway solver takes 2-${MULTIWAY_MAX_PLAYERS} players.`);
  if(!Number.isInteger(input.heroIndex)||input.heroIndex<0||input.heroIndex>=input.players.length)throw new Error("Hero must be one of the players.");
  const pot=toChips(input.pot);
  // A zero stack is a player all-in from an earlier street; Hero must still have chips to act.
  if(!(pot>0)||input.players.some(player=>!(toChips(player.stack)>=0))||!(toChips(input.players[input.heroIndex].stack)>0))throw new Error("Pot and Hero's street-start stack must be positive.");
  const potLayers=chipLayers(input.potLayers,pot,input.players.length);
  const {history,sizesByDepth,aggressions}=encodeHistory(input,pot);
  const baseBet=input.betPercent.map(percent=>fraction(Math.round(percent),100));
  const baseRaise=input.raisePercent.map(percent=>fraction(Math.round(percent),100));
  const depthCount=Math.max(2,sizesByDepth.length);
  return {
    board:cardCodes(input.board,[4,5],"Board"),
    hero:cardCodes(input.heroHole,[2],"Hero"),
    heroSeat:input.heroIndex,
    players:input.players.map(player=>({range:player.range,stack:toChips(player.stack)})),
    pot,...(potLayers?{potLayers}:{}),iterations:input.iterations,
    betSizes:Array.from({length:depthCount},(_,depth)=>mergeSizes(depth===0?baseBet:baseRaise,sizesByDepth[depth])),
    maxRaises:Math.min(MAX_RAISES,Math.max(2,aggressions+1)),
    history,
    ...(input.timeBudgetMs===undefined?{}:{timeBudgetMs:Math.round(input.timeBudgetMs)}),
  };
}

export type MultiwaySolveResponse={ok:true;result:{
  source:string;player:number;players:number;best_action:string;heroUnreached?:boolean;iterations?:number;
  /** "checkdown": a turn solve that models the river as checked down (approximate EV). */
  riverModel?:"checkdown"|"played";
  stoppedBy?:"deadline"|"iterations";elapsedMs?:number;strategy:{action:string;frequency:number;evChips:number}[];
  convergence:{metric:"maxBrGainPctPot";maxBrGain:number;brGain:number[]}|null;
}}|{ok:false;error:string};

/** Normalized solver JSON; EVs in BB. `maxBrGain` replaces exploitability, which is undefined with 3+ players. */
export function multiwayResponseToSolverJson(response:MultiwaySolveResponse){
  if(!response.ok)throw new Error(`Multiway solver: ${response.error}`);
  const {result}=response;
  return JSON.stringify({
    source:"multiway-native",
    strategy:result.strategy.map(item=>({action:item.action,frequency:item.frequency,ev:item.evChips/CHIPS_PER_BB})),
    best_action:result.best_action,
    // Omitted when the best-response pass did not fit in the time budget.
    ...(result.convergence&&Number.isFinite(result.convergence.maxBrGain)?{maxBrGain:result.convergence.maxBrGain}:{}),
    iterations:result.iterations,stoppedBy:result.stoppedBy,
    ...(result.riverModel==="checkdown"?{riverModel:"checkdown"}:{}),
    ...(result.heroUnreached?{note:"평균 전략에서 Hero 핸드는 이 라인에 도달하지 않습니다. 빈도 대신 EV가 가장 높은 액션을 표시합니다."}:{}),
  });
}
