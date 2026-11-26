/**
 * Malmuth-Harville ICM: a player finishes in the next open place with probability stack / remaining chips.
 * Exact over every finishing order with memoization over the set of players still in, so it is limited to
 * MAX_ICM_PLAYERS (2^n x n^2 work).
 */
export const MAX_ICM_PLAYERS=10;

export interface IcmOutcome { probability:number;stacksAfter:readonly number[]; }

function validate(stacks:readonly number[],payouts:readonly number[]){
  if(stacks.length<1||stacks.length>MAX_ICM_PLAYERS)throw new Error(`ICM은 1~${MAX_ICM_PLAYERS}명까지 계산합니다.`);
  if(stacks.some(stack=>!Number.isFinite(stack)||stack<0))throw new Error("스택은 0 이상의 숫자여야 합니다.");
  if(payouts.length<1||payouts.length>MAX_ICM_PLAYERS||payouts.some(payout=>!Number.isFinite(payout)||payout<0))throw new Error(`상금은 1~${MAX_ICM_PLAYERS}개의 0 이상 숫자여야 합니다.`);
}

/** Prize equity of each player; busted players (stack 0) take the lowest places, sharing their prizes evenly. */
export function icmEquity(stacks:readonly number[],payouts:readonly number[]):number[]{
  validate(stacks,payouts);
  const prize=(place:number)=>payouts[place]??0;
  const alive=stacks.map((stack,index)=>stack>0?index:-1).filter(index=>index>=0);
  const busted=stacks.map((stack,index)=>stack>0?-1:index).filter(index=>index>=0);
  const equity=stacks.map(()=>0);
  // Busted players split the places below everyone still alive.
  if(busted.length){
    const shared=busted.reduce((sum,_,offset)=>sum+prize(alive.length+offset),0)/busted.length;
    for(const index of busted)equity[index]=shared;
  }
  if(!alive.length)return equity;
  const memo=new Map<number,number[]>();
  // Equity of each alive player (by position in `alive`) when the players in `mask` compete for places from `place`.
  const solve=(mask:number,place:number):number[]=>{
    const cached=memo.get(mask);
    if(cached)return cached;
    const result=alive.map(()=>0);
    let total=0;
    for(let bit=0;bit<alive.length;bit++)if(mask&(1<<bit))total+=stacks[alive[bit]];
    for(let bit=0;bit<alive.length;bit++){
      if(!(mask&(1<<bit)))continue;
      const chance=stacks[alive[bit]]/total;
      result[bit]+=chance*prize(place);
      const rest=mask&~(1<<bit);
      if(!rest)continue;
      const below=solve(rest,place+1);
      for(let other=0;other<alive.length;other++)result[other]+=chance*below[other];
    }
    memo.set(mask,result);
    return result;
  };
  const top=solve((1<<alive.length)-1,0);
  alive.forEach((index,bit)=>{equity[index]=top[bit];});
  return equity;
}

/**
 * Hero's prize-equity change for a decision with these chip outcomes, against keeping the current stacks. Each
 * outcome should hold the same total chips as `stacksBefore`, or the baseline is not like for like.
 */
export function dollarEvChange(input:{stacksBefore:readonly number[];outcomes:readonly IcmOutcome[];payouts:readonly number[];heroIndex:number}):number{
  const {stacksBefore,outcomes,payouts,heroIndex}=input;
  if(!Number.isInteger(heroIndex)||heroIndex<0||heroIndex>=stacksBefore.length)throw new Error("Hero 좌석 번호가 범위를 벗어났습니다.");
  const totalProbability=outcomes.reduce((sum,outcome)=>sum+outcome.probability,0);
  if(!outcomes.length||outcomes.some(outcome=>!(outcome.probability>=0)||outcome.stacksAfter.length!==stacksBefore.length)||Math.abs(totalProbability-1)>1e-6)throw new Error("결과 확률의 합은 1이고 스택 수가 같아야 합니다.");
  const before=icmEquity(stacksBefore,payouts)[heroIndex];
  return outcomes.reduce((sum,outcome)=>sum+outcome.probability*icmEquity(outcome.stacksAfter,payouts)[heroIndex],0)-before;
}

/** Parses "50,30,20" (or with spaces / percent signs) into prizes; null when invalid. */
export function parsePayouts(text:string):number[]|null{
  const parts=text.split(/[,\s]+/).map(part=>part.replace(/%$/,"")).filter(Boolean);
  if(!parts.length||parts.length>MAX_ICM_PLAYERS)return null;
  const values=parts.map(Number);
  // Each prize and their total must stay finite so shares never become Infinity/Infinity.
  const total=values.reduce((sum,value)=>sum+value,0);
  return values.every(value=>Number.isFinite(value)&&value>=0)&&total>0&&Number.isFinite(total)?values:null;
}
