import type { Position } from "./preflop";
import type { Street } from "./game-state";

export type PostflopActionType="fold"|"check"|"bet"|"call"|"raise";
export interface PostflopAction { id:string; street:Exclude<Street,"preflop">; seat:number; position:Position; type:PostflopActionType; amount:number; }

export function postflopOrder(positions:Position[],folded:Set<number>){
  const order:Position[]=["SB","BB","UTG","UTG+1","MP","HJ","CO","BTN"];
  return order.map(position=>positions.indexOf(position)).filter(seat=>seat>=0&&!folded.has(seat));
}
