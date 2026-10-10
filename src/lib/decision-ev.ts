export interface EstimatedEv { action:string;ev:number;assumption:string; }
export interface StrategyWithEv { action:string;frequency:number;ev:number;evSource:"solver"|"model"; }

/**
 * `pot` includes every chip committed so far, `betSize` is the hero's total commitment on this street after the
 * bet or raise, and `heroCommitted` is what the hero already put in on this street. `maxCommitment` is the largest
 * street total that can be matched (the smaller of the hero's and the deepest opponent's street-start stack).
 */
export interface ActionEvInput { equity:number;pot:number;toCall:number;betSize:number;heroCommitted?:number;maxCommitment?:number;foldEquity?:number;equityWhenCalled?:number;opponents?:number; }

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
    results.push({action:"call",ev:equity*contestedPot-callCost,assumption:`MODEL · 향후 베팅을 제외한 showdown equity${callCost<input.toCall?" · 숏 올인 콜":""}`});
  }
  else results.push({action:"check",ev:equity*input.pot,assumption:"MODEL · 즉시 showdown 가치"});
  const sizing=aggressionSizing(input);
  if(sizing){
    const foldEquity=probability(input.foldEquity??defaultFoldEquity(input));
    const calledEquity=input.equityWhenCalled===undefined?equity:probability(input.equityWhenCalled/100);
    const calledPot=input.pot+sizing.heroRisk+sizing.villainCall;
    const calledSource=input.equityWhenCalled===undefined?"전체 레인지 Equity(낙관적)":`콜 레인지 Equity ${percent(calledEquity)}%`;
    const foldSource=input.foldEquity===undefined?"break-even 기준":"지정값";
    results.push({action:input.toCall>0?"raise":"bet",ev:foldEquity*input.pot+(1-foldEquity)*(calledEquity*calledPot-sizing.heroRisk),assumption:`MODEL · 상대 Fold ${percent(foldEquity)}%(${foldSource}) · ${calledSource}${(input.opponents??1)>1?" · heads-up 근사":""}`});
  }
  return results.map(result=>({...result,ev:Math.round(result.ev*100)/100}));
}

export function attachActionEvs(strategy:{action:string;frequency:number;ev?:number}[],estimated:EstimatedEv[]):StrategyWithEv[]{
  return strategy.map(item=>{
    if(typeof item.ev==="number")return {action:item.action,frequency:item.frequency,ev:item.ev,evSource:"solver" as const};
    const fallback=estimated.find(value=>value.action===item.action);
    return {action:item.action,frequency:item.frequency,ev:fallback?.ev??0,evSource:"model" as const};
  });
}
