import type { Street } from "./game-state";
import type { PostflopAction, PostflopActionType } from "./postflop-machine";

type PostflopStreet=Exclude<Street,"preflop">;
const streetIndex:Record<PostflopStreet,number>={flop:0,turn:1,river:2};

export interface PostflopContext {
  street:PostflopStreet;
  actions:PostflopAction[];
  contributions:Map<number,number>;
  remainingAtStart:number[];
  foldedSeats:Set<number>;
  allInSeats:Set<number>;
  currentBet:number;
  lastFullRaiseSize:number;
  lastFullRaiseIndex:number;
  potBefore:number;
  pot:number;
}

function finalStreetContributions(actions:PostflopAction[]){
  const values=new Map<number,number>();
  for(const action of actions)if(!["fold","check"].includes(action.type))values.set(action.seat,action.amount);
  return values;
}

export function buildPostflopContext(input:{actions:PostflopAction[];street:PostflopStreet;seats:number[];initialRemaining:number[];initialPot:number}):PostflopContext{
  const prior=input.actions.filter(action=>streetIndex[action.street]<streetIndex[input.street]);
  const current=input.actions.filter(action=>action.street===input.street);
  const remaining=[...input.initialRemaining];
  let potBefore=input.initialPot;
  for(const street of (["flop","turn"] as PostflopStreet[]).filter(value=>streetIndex[value]<streetIndex[input.street])){
    const committed=finalStreetContributions(prior.filter(action=>action.street===street));
    for(const [seat,amount] of committed){remaining[seat]=Math.max(0,(remaining[seat]??0)-amount);potBefore+=amount;}
  }
  const foldedSeats=new Set(prior.filter(action=>action.type==="fold").map(action=>action.seat));
  const allInSeats=new Set(input.seats.filter(seat=>(remaining[seat]??0)<=0));
  const contributions=new Map(input.seats.map(seat=>[seat,0]));
  let currentBet=0,lastFullRaiseSize=0,lastFullRaiseIndex=-1;
  for(const [index,action] of current.entries()){
    if(action.type==="fold"){foldedSeats.add(action.seat);continue;}
    if(action.type==="check")continue;
    contributions.set(action.seat,action.amount);
    if(action.amount>=(remaining[action.seat]??0))allInSeats.add(action.seat);
    if(action.type==="bet"||action.type==="raise"){
      const increment=action.amount-currentBet;
      const fullRaise=currentBet===0?increment>0:increment>=lastFullRaiseSize;
      if(fullRaise){lastFullRaiseSize=increment;lastFullRaiseIndex=index;}
      currentBet=action.amount;
    }
  }
  const streetPot=[...contributions.values()].reduce((sum,value)=>sum+value,0);
  return {street:input.street,actions:current,contributions,remainingAtStart:remaining,foldedSeats,allInSeats,currentBet,lastFullRaiseSize,lastFullRaiseIndex,potBefore,pot:potBefore+streetPot};
}

export function availablePostflopActions(context:PostflopContext,seat:number):PostflopActionType[]{
  if(context.foldedSeats.has(seat)||context.allInSeats.has(seat))return [];
  const committed=context.contributions.get(seat)??0;
  if(committed===context.currentBet)return context.currentBet===0?["check","bet"]:["check","raise"];
  const seatLast=context.actions.findLastIndex(action=>action.seat===seat);
  const facedShortRaise=seatLast>=context.lastFullRaiseIndex&&context.actions.slice(seatLast+1).some(action=>action.type==="raise");
  return facedShortRaise?["fold","call"]:["fold","call","raise"];
}

export function validatePostflopActionV2(context:PostflopContext,seat:number,type:PostflopActionType,amount:number){
  if(!availablePostflopActions(context,seat).includes(type))return {valid:false,message:`현재 ${type} 액션을 사용할 수 없습니다.`};
  if(type==="fold"||type==="check")return {valid:true,message:"유효한 액션입니다."};
  const stack=context.remainingAtStart[seat]??0;
  if(amount>stack)return {valid:false,message:`남은 스택 ${stack}BB를 초과할 수 없습니다.`,maximumAmount:stack};
  if(type==="call"){
    const target=Math.min(context.currentBet,stack);
    if(amount!==target)return {valid:false,message:`Call 총액은 ${target}BB입니다.`,minimumAmount:target};
  }
  if(type==="bet"&&amount<=0)return {valid:false,message:"Bet 금액은 0보다 커야 합니다.",minimumAmount:Math.min(1,stack)};
  if(type==="raise"){
    const minimum=context.currentBet+context.lastFullRaiseSize;
    if(amount<minimum&&amount!==stack)return {valid:false,message:`최소 Raise 총액은 ${minimum}BB입니다.`,minimumAmount:Math.min(minimum,stack)};
  }
  return {valid:true,message:"유효한 액션입니다."};
}

export function isPostflopRoundComplete(context:PostflopContext,seats:number[]){
  if(!context.actions.length)return false;
  const live=seats.filter(seat=>!context.foldedSeats.has(seat));
  if(live.length<=1)return true;
  const actionable=live.filter(seat=>!context.allInSeats.has(seat));
  if(actionable.length===0)return true;
  const boundary=Math.max(0,context.lastFullRaiseIndex);
  return actionable.every(seat=>context.actions.some((action,index)=>index>=boundary&&action.seat===seat&&action.type!=="fold")&&(context.contributions.get(seat)??0)===context.currentBet);
}

export function nextPostflopActor(context:PostflopContext,order:number[]){
  if(isPostflopRoundComplete(context,order))return null;
  if(!context.actions.length)return order.find(seat=>!context.foldedSeats.has(seat)&&!context.allInSeats.has(seat))??null;
  const lastSeat=context.actions.at(-1)!.seat;const lastIndex=order.indexOf(lastSeat);
  for(let offset=1;offset<=order.length;offset++){const seat=order[(lastIndex+offset)%order.length];if(!context.foldedSeats.has(seat)&&!context.allInSeats.has(seat))return seat;}
  return null;
}
