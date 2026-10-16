import type { PostflopActionType } from "../postflop-machine";
import { CHIPS_PER_BB, MAX_RAISES, cardCodes, fraction, mergeSizes, toChips, type Fraction, type WasmHistoryAction } from "./request";

/** The native multiway solver supports this many players on the river. */
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
  /** Current-street actions; `player` indexes `players`, `amount` is the actor's street-total commitment in BB. */
  history:MultiwayHistoryStep[];
  iterations:number;betPercent:number[];raisePercent:number[];timeBudgetMs?:number;
}
export interface MultiwaySolveRequest {
  board:string;hero:string;heroSeat:number;players:{range:string;stack:number}[];pot:number;iterations:number;
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

export function buildMultiwaySolveRequest(input:MultiwaySolveInput):MultiwaySolveRequest{
  if(input.players.length<2||input.players.length>MULTIWAY_MAX_PLAYERS)throw new Error(`The multiway solver takes 2-${MULTIWAY_MAX_PLAYERS} players.`);
  if(!Number.isInteger(input.heroIndex)||input.heroIndex<0||input.heroIndex>=input.players.length)throw new Error("Hero must be one of the players.");
  const pot=toChips(input.pot);
  if(!(pot>0)||input.players.some(player=>!(toChips(player.stack)>0)))throw new Error("Pot and every street-start stack must be positive.");
  const {history,sizesByDepth,aggressions}=encodeHistory(input,pot);
  const baseBet=input.betPercent.map(percent=>fraction(Math.round(percent),100));
  const baseRaise=input.raisePercent.map(percent=>fraction(Math.round(percent),100));
  const depthCount=Math.max(2,sizesByDepth.length);
  return {
    board:cardCodes(input.board,[5],"Board"),
    hero:cardCodes(input.heroHole,[2],"Hero"),
    heroSeat:input.heroIndex,
    players:input.players.map(player=>({range:player.range,stack:toChips(player.stack)})),
    pot,iterations:input.iterations,
    betSizes:Array.from({length:depthCount},(_,depth)=>mergeSizes(depth===0?baseBet:baseRaise,sizesByDepth[depth])),
    maxRaises:Math.min(MAX_RAISES,Math.max(2,aggressions+1)),
    history,
    ...(input.timeBudgetMs===undefined?{}:{timeBudgetMs:Math.round(input.timeBudgetMs)}),
  };
}

export type MultiwaySolveResponse={ok:true;result:{
  source:string;player:number;players:number;best_action:string;heroUnreached?:boolean;iterations?:number;
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
    ...(result.heroUnreached?{note:"평균 전략에서 Hero 핸드는 이 라인에 도달하지 않습니다. 빈도 대신 EV가 가장 높은 액션을 표시합니다."}:{}),
  });
}
