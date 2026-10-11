import { parseCard } from "../equity";
import type { PostflopActionType } from "../postflop-machine";

/** The wasm solver works in integer chips; RangeLab amounts are BB, so 1 chip = 1/100 BB. */
export const CHIPS_PER_BB=100;
/** dcfr-solver's tree accepts at most four bets/raises per street. */
const MAX_RAISES=4;
const MAX_SIZES_PER_DEPTH=6;

type Role="oop"|"ip";
type Fraction=[number,number];

export interface WasmHistoryStep { role:Role;action:PostflopActionType;amount:number; }
export interface WasmSolveInput {
  board:string[];heroHole:string[];oopRange:string;ipRange:string;
  /** Pot and stacks at the start of the street, in BB. */
  pot:number;stacks:Record<Role,number>;
  /** Current-street actions; `amount` is the actor's street-total commitment in BB. */
  history:WasmHistoryStep[];
  iterations:number;betPercent:number[];raisePercent:number[];
}
export type WasmHistoryAction={action:"check"|"call"|"fold"|"allin"}|{action:"bet"|"raise";size:Fraction};
export interface WasmSolveRequest { board:string;hero:string;oopRange:string;ipRange:string;pot:number;stacks:[number,number];iterations:number;betSizes:Fraction[][];maxRaises:number;history:WasmHistoryAction[]; }

const toChips=(bb:number)=>Math.round(bb*CHIPS_PER_BB);
const greatestCommonDivisor=(left:number,right:number):number=>right===0?left:greatestCommonDivisor(right,left%right);

/** Reduced fraction, so equal sizes have one representation; the solver matches actions by exact fraction. */
function fraction(numerator:number,denominator:number):Fraction{
  const divisor=greatestCommonDivisor(numerator,denominator);
  return [numerator/divisor,denominator/divisor];
}

const sameFraction=(left:Fraction,right:Fraction)=>left[0]===right[0]&&left[1]===right[1];

function cardCodes(codes:string[],expected:number[],label:string){
  const cards=codes.map(parseCard);
  if(!expected.includes(cards.length)||cards.some(card=>!card))throw new Error(`${label} cards are invalid.`);
  return (cards as NonNullable<ReturnType<typeof parseCard>>[]).map(card=>card.code).join("");
}

interface HistoryEncoding { history:WasmHistoryAction[];sizesByDepth:Fraction[][];aggressions:number; }

/**
 * Mirrors dcfr-solver's sizing: a bet is `fraction * (pot + street bets)`; a raise adds `fraction * potAfterCall`
 * on top of the bet faced. Encoding observed chips as that exact fraction reproduces the node without rounding.
 */
function encodeHistory(input:WasmSolveInput,pot:number):HistoryEncoding{
  const stacks={oop:toChips(input.stacks.oop),ip:toChips(input.stacks.ip)};
  const bets={oop:0,ip:0};
  const history:WasmHistoryAction[]=[];const sizesByDepth:Fraction[][]=[];let aggressions=0;
  for(const step of input.history){
    const opponent:Role=step.role==="oop"?"ip":"oop";
    const amount=toChips(step.amount);
    if(step.action==="check"||step.action==="fold"){history.push({action:step.action});continue;}
    if(step.action==="call"){
      history.push({action:bets[opponent]>=stacks[step.role]?"allin":"call"});
      bets[step.role]=Math.min(bets[opponent],stacks[step.role]);
      continue;
    }
    if(aggressions+1>=MAX_RAISES)throw new Error(`The in-browser solver supports at most ${MAX_RAISES-1} bets and raises before the decision.`);
    const depth=aggressions;aggressions++;
    if(amount>=stacks[step.role]){history.push({action:"allin"});bets[step.role]=stacks[step.role];continue;}
    const currentPot=pot+bets.oop+bets.ip;
    const toCall=bets[opponent]-bets[step.role];
    const size=toCall>0?fraction(amount-bets[opponent],currentPot+toCall):fraction(amount,currentPot);
    if(size[0]<=0)throw new Error(`Observed ${step.action} ${step.amount}BB does not exceed the current bet.`);
    // dcfr-solver drops raises whose increment is below the bet faced minus one chip (game.rs min_previous_bet).
    if(toCall>0&&amount-bets[opponent]<bets[opponent]-1)throw new Error(`${step.amount}BB 레이즈는 브라우저 Solver 트리의 최소 레이즈(증분 >= 직전 베팅 ${bets[opponent]/CHIPS_PER_BB}BB)보다 작아 풀 수 없습니다.`);
    history.push({action:toCall>0?"raise":"bet",size});
    sizesByDepth[depth]=[...(sizesByDepth[depth]??[]),size];
    bets[step.role]=amount;
  }
  return {history,sizesByDepth,aggressions};
}

function mergeSizes(base:Fraction[],observed:Fraction[]=[]){
  const merged=[...base];
  for(const size of observed)if(!merged.some(existing=>sameFraction(existing,size)))merged.push(size);
  if(merged.length>MAX_SIZES_PER_DEPTH)throw new Error(`Too many bet sizes at one raise level (max ${MAX_SIZES_PER_DEPTH}).`);
  return merged;
}

export function buildWasmSolveRequest(input:WasmSolveInput):WasmSolveRequest{
  const pot=toChips(input.pot);
  if(!(pot>0)||!(input.stacks.oop>0)||!(input.stacks.ip>0))throw new Error("Pot and stacks must be positive.");
  const {history,sizesByDepth,aggressions}=encodeHistory(input,pot);
  const baseBet=input.betPercent.map(percent=>fraction(Math.round(percent),100));
  const baseRaise=input.raisePercent.map(percent=>fraction(Math.round(percent),100));
  const depthCount=Math.max(2,sizesByDepth.length);
  const betSizes=Array.from({length:depthCount},(_,depth)=>mergeSizes(depth===0?baseBet:baseRaise,sizesByDepth[depth]));
  return {
    board:cardCodes(input.board,[3,4,5],"Board"),
    hero:cardCodes(input.heroHole,[2],"Hero"),
    oopRange:input.oopRange,ipRange:input.ipRange,
    pot,stacks:[toChips(input.stacks.oop),toChips(input.stacks.ip)],
    iterations:input.iterations,
    betSizes,
    // One more bet level than observed so the acting player can still raise.
    maxRaises:Math.min(MAX_RAISES,Math.max(2,aggressions+1)),
    history,
  };
}

export type WasmSolveResponse={ok:true;result:{source:string;player:Role;best_action:string;exploitability:number;heroUnreached?:boolean;strategy:{action:string;frequency:number;evChips:number}[]}}|{ok:false;error:string};

/** Converts a dcfr-core envelope (wasm or native adapter) to RangeLab's normalized solver JSON with EV in BB. */
export function wasmResponseToSolverJson(response:WasmSolveResponse){
  if(!response.ok)throw new Error(`In-browser solver: ${response.error}`);
  const {result}=response;
  return JSON.stringify({
    source:result.source==="dcfr-native"?"dcfr-native":"dcfr-wasm",
    strategy:result.strategy.map(item=>({action:item.action,frequency:item.frequency,ev:item.evChips/CHIPS_PER_BB})),
    best_action:result.best_action,
    exploitability:result.exploitability,
    ...(result.heroUnreached?{note:"균형 전략에서 Hero 핸드는 이 라인에 도달하지 않습니다. 빈도 대신 EV가 가장 높은 액션을 표시합니다."}:{}),
  });
}
