import { defaultMultiwayFolds, multiwayBetEv, type SubsetEquities } from "./multiway-ev";

export interface EstimatedEv { action:string;ev:number;assumption:string; }
export interface StrategyWithEv { action:string;frequency:number;ev:number;evSource:"solver"|"model"; }

/**
 * `pot` includes every chip committed so far, `betSize` is the hero's total commitment on this street after the
 * bet or raise, and `heroCommitted` is what the hero already put in on this street. `maxCommitment` is the largest
 * street total that can be matched (the smaller of the hero's and the deepest opponent's street-start stack).
 */
export interface ActionEvInput {
  equity:number;pot:number;toCall:number;betSize:number;heroCommitted?:number;maxCommitment?:number;foldEquity?:number;equityWhenCalled?:number;opponents?:number;
  /** Multiway: fold probability per opponent; without it each opponent who can fold gets the default multiway share. */
  foldEquities?:readonly number[];
  /** Multiway: which opponents can fold (false when all in); defaults to all of `opponents`. */
  foldable?:readonly boolean[];
  /** Multiway: hero equity per caller subset (see estimateSubsetEquities), keyed by opponent index. */
  calledEquities?:SubsetEquities;
  /** Most each opponent can add beyond the current bet. */
  callCaps?:readonly number[];
  /** What each opponent still owes to reach the current bet before calling a raise. */
  owed?:readonly number[];
  /** Opponents who still act after a hero call (overcalls and squeezes are not modeled). */
  playersBehind?:number;
}

interface AggressionSizing { heroRisk:number;villainCall:number; }

function aggressionSizing(input:Pick<ActionEvInput,"toCall"|"betSize"|"heroCommitted"|"maxCommitment">):AggressionSizing|null{
  const heroCommitted=Math.max(0,input.heroCommitted??0);
  const currentBet=heroCommitted+Math.max(0,input.toCall);
  const betSize=Math.min(input.betSize,input.maxCommitment??Number.POSITIVE_INFINITY);
  if(!Number.isFinite(betSize)||betSize<=currentBet)return null;
  return {heroRisk:betSize-heroCommitted,villainCall:betSize-currentBet};
}

/** Fold frequency that makes a pure bluff break even: risk / (pot + risk). Zero when no legal bet size is given. */
export function defaultFoldEquity(input:Pick<ActionEvInput,"pot"|"toCall"|"betSize"|"heroCommitted"|"maxCommitment">){
  const sizing=aggressionSizing(input);
  return sizing?sizing.heroRisk/(input.pot+sizing.heroRisk):0;
}

const probability=(value:number)=>Math.min(1,Math.max(0,value));
const percent=(value:number)=>Math.round(value*100);

/** Simplified one-street model; showdown equity ignores future betting and realization. */
export function estimateActionEvs(input:ActionEvInput):EstimatedEv[]{
  const equity=probability(input.equity/100);
  const results:EstimatedEv[]=[{action:"fold",ev:0,assumption:"MODEL · Fold EV 기준점"}];
  if(input.toCall>0){
    // A short stack calls all-in; the bettor's uncalled excess goes back to them.
    const callCost=Math.max(0,Math.min(input.toCall,(input.maxCommitment??Number.POSITIVE_INFINITY)-Math.max(0,input.heroCommitted??0)));
    const contestedPot=input.pot-(input.toCall-callCost)+callCost;
    results.push({action:"call",ev:equity*contestedPot-callCost,assumption:`MODEL · 향후 베팅을 제외한 showdown equity${callCost<input.toCall?" · 숏 올인 콜":""}${input.playersBehind?` · 뒤 ${input.playersBehind}명 오버콜/스퀴즈 미반영`:""}`});
  }
  else results.push({action:"check",ev:equity*input.pot,assumption:"MODEL · 즉시 showdown 가치"});
  const sizing=aggressionSizing(input);
  if(sizing)results.push(betEstimate(input,sizing,equity));
  return results.map(result=>({...result,ev:Math.round(result.ev*100)/100}));
}

function opponentFolds(input:ActionEvInput,sizing:AggressionSizing){
  if(input.foldEquities)return input.foldEquities.map(probability);
  const foldable=input.foldable?.length?input.foldable:Array<boolean>(Math.max(1,input.opponents??1)).fill(true);
  if(foldable.length===1)return [foldable[0]?probability(input.foldEquity??defaultFoldEquity(input)):0];
  return defaultMultiwayFolds(sizing.heroRisk/(input.pot+sizing.heroRisk),foldable);
}

/** Bet or raise EV against independent opponents; with one opponent this is the heads-up fold/call formula. */
function betEstimate(input:ActionEvInput,sizing:AggressionSizing,equity:number):EstimatedEv{
  const folds=opponentFolds(input,sizing);
  const calledEquity=input.equityWhenCalled===undefined?equity:probability(input.equityWhenCalled/100);
  const equities=input.calledEquities??{byKey:new Map<string,number>(),everyone:calledEquity*100};
  const result=multiwayBetEv({pot:input.pot,heroRisk:sizing.heroRisk,villainCall:sizing.villainCall,folds,callCaps:input.callCaps,owed:input.owed,equities});
  const explicitFolds=input.foldEquities!==undefined||(folds.length===1&&input.foldEquity!==undefined);
  const foldSource=explicitFolds?"지정값":"break-even 기준";
  const calledSource=input.calledEquities?"콜 조합별 Equity":input.equityWhenCalled===undefined?"전체 레인지 Equity(낙관적)":`콜 레인지 Equity ${percent(calledEquity)}%`;
  const action=input.toCall>0?"raise":"bet";
  if(folds.length===1)return {action,ev:result.ev,assumption:`MODEL · 상대 Fold ${percent(folds[0])}%(${foldSource}) · ${calledSource}`};
  const rare=input.calledEquities&&result.approximate?" (희귀 조합은 전원 콜 Equity)":"";
  return {action,ev:result.ev,assumption:`MODEL · 멀티웨이 ${folds.length}명 · 전원 Fold ${percent(result.foldAll)}%(${foldSource}) · 예상 콜러 ${result.expectedCallers.toFixed(1)}명 · ${calledSource}${rare}`};
}

export function attachActionEvs(strategy:{action:string;frequency:number;ev?:number}[],estimated:EstimatedEv[]):StrategyWithEv[]{
  return strategy.map(item=>{
    if(typeof item.ev==="number")return {action:item.action,frequency:item.frequency,ev:item.ev,evSource:"solver" as const};
    const fallback=estimated.find(value=>value.action===item.action);
    return {action:item.action,frequency:item.frequency,ev:fallback?.ev??0,evSource:"model" as const};
  });
}
