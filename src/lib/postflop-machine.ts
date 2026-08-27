import type { Position } from "./preflop";
import type { Street } from "./game-state";

export type PostflopActionType="fold"|"check"|"bet"|"call"|"raise";
export interface PostflopAction { id:string; street:Exclude<Street,"preflop">; seat:number; position:Position; type:PostflopActionType; amount:number; }

export function postflopOrder(positions:Position[],folded:Set<number>){
  const order:Position[]=["SB","BB","UTG","UTG+1","MP","HJ","CO","BTN"];
  return order.map(position=>positions.indexOf(position)).filter(seat=>seat>=0&&!folded.has(seat));
}

export function derivePostflopState(actions:PostflopAction[],activeSeats:number[],stack:number){
  const contributions=new Map<number,number>(activeSeats.map(seat=>[seat,0]));
  const folded=new Set<number>();
  let currentBet=0,lastRaiseSize=0,aggressionCount=0;
  for(const action of actions){
    if(action.type==="fold"){folded.add(action.seat);continue;}
    contributions.set(action.seat,action.amount);
    if(action.type==="bet"||action.type==="raise"){
      const increment=action.amount-currentBet;
      currentBet=action.amount;lastRaiseSize=increment;aggressionCount++;
    }
  }
  const streetPot=[...contributions.values()].reduce((sum,value)=>sum+value,0);
  return {contributions,folded,currentBet,lastRaiseSize,aggressionCount,streetPot,stack};
}

export function postflopAvailable(actions:PostflopAction[],activeSeats:number[],seat:number,stack:number):PostflopActionType[]{
  const state=derivePostflopState(actions,activeSeats,stack);
  if(state.folded.has(seat))return [];
  const committed=state.contributions.get(seat)??0;
  return state.currentBet===committed?["check","bet"]:["fold","call","raise"];
}

export function validatePostflopAction(input:{actions:PostflopAction[];activeSeats:number[];seat:number;type:PostflopActionType;amount:number;stack:number}){
  const state=derivePostflopState(input.actions,input.activeSeats,input.stack);
  const allowed=postflopAvailable(input.actions,input.activeSeats,input.seat,input.stack);
  if(!allowed.includes(input.type))return {valid:false,message:`현재 ${input.type} 액션을 사용할 수 없습니다.`};
  if(input.type==="fold"||input.type==="check")return {valid:true,message:"유효한 액션입니다."};
  if(input.amount>input.stack)return {valid:false,message:`스택 ${input.stack}BB를 초과할 수 없습니다.`};
  if(input.type==="call"&&input.amount!==state.currentBet&&!(input.amount===input.stack&&input.stack<state.currentBet))return {valid:false,message:`Call 총액은 ${Math.min(state.currentBet,input.stack)}BB입니다.`,minimumAmount:Math.min(state.currentBet,input.stack)};
  if(input.type==="bet"&&input.amount<=0)return {valid:false,message:"Bet 금액은 0보다 커야 합니다.",minimumAmount:1};
  if(input.type==="raise"){
    const minimum=state.currentBet+state.lastRaiseSize;
    if(input.amount<minimum&&input.amount!==input.stack)return {valid:false,message:`최소 Raise 총액은 ${minimum}BB입니다.`,minimumAmount:minimum};
  }
  return {valid:true,message:"유효한 액션입니다."};
}

export function isPostflopComplete(actions:PostflopAction[],activeSeats:number[],stack:number){
  if(!actions.length)return false;
  const state=derivePostflopState(actions,activeSeats,stack);
  const remaining=activeSeats.filter(seat=>!state.folded.has(seat));
  if(remaining.length<=1)return true;
  const lastAggression=actions.findLastIndex(action=>action.type==="bet"||action.type==="raise");
  const boundary=Math.max(0,lastAggression);
  return remaining.every(seat=>actions.some((action,index)=>index>=boundary&&action.seat===seat&&action.type!=="fold")&&(state.contributions.get(seat)??0)===state.currentBet);
}

export function nextPostflopSeat(actions:PostflopAction[],order:number[],stack:number){
  if(isPostflopComplete(actions,order,stack))return null;
  if(!actions.length)return order[0]??null;
  const folded=derivePostflopState(actions,order,stack).folded;
  const last=order.indexOf(actions.at(-1)!.seat);
  for(let offset=1;offset<=order.length;offset++){const seat=order[(last+offset)%order.length];if(!folded.has(seat))return seat;}
  return null;
}
