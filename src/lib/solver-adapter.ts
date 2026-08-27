import type { PostflopActionType } from "./postflop-machine";

export interface SolverNodeV1 { contract:"rangelab.solver_node.v1";street:"flop"|"turn"|"river";heroHole:string[];board:string[];pot:number;toCall:number;effectiveStack:number;candidateActions:PostflopActionType[]; }
export interface SolverActionResult { action:PostflopActionType;frequency:number;ev?:number; }
export interface SolverResult { source:"texassolver"|"openspiel"|"imported";actions:SolverActionResult[];bestAction:PostflopActionType;exploitability?:number;evSource:"solver"|"unavailable"; }

const validActions=new Set<PostflopActionType>(["fold","check","bet","call","raise"]);
const normalizeAction=(raw:string):PostflopActionType|null=>{
  const value=raw.trim().toLowerCase();
  if(value.startsWith("fold"))return "fold";
  if(value.startsWith("check"))return "check";
  if(value.startsWith("call"))return "call";
  if(value.startsWith("raise"))return "raise";
  if(value.startsWith("bet")||value.startsWith("allin")||value.startsWith("all-in"))return "bet";
  return null;
};

export function createSolverNode(input:Omit<SolverNodeV1,"contract">):SolverNodeV1{
  const cards=[...input.heroHole,...input.board].map(card=>card.trim().toUpperCase());
  if(input.heroHole.length!==2)throw new Error("Hero hole cards must contain exactly two cards.");
  if(new Set(cards).size!==cards.length)throw new Error("Solver node contains duplicated cards.");
  if(input.pot<0||input.toCall<0||input.effectiveStack<=0)throw new Error("Pot, call, and stack values are invalid.");
  return {contract:"rangelab.solver_node.v1",...input};
}

export function parseTexasSolverNode(raw:string,heroCombo:string):SolverResult{
  const value:unknown=JSON.parse(raw);if(!value||typeof value!=="object")throw new Error("TexasSolver node object is required.");
  const node=value as Record<string,unknown>;const strategy=node.strategy;
  if(!strategy||typeof strategy!=="object")throw new Error("TexasSolver strategy node was not found.");
  const strategyNode=strategy as Record<string,unknown>;
  const rawActions=Array.isArray(strategyNode.actions)?strategyNode.actions:[];
  const comboMap=strategyNode.strategy;
  if(!comboMap||typeof comboMap!=="object")throw new Error("TexasSolver combo strategy map was not found.");
  const normalizedCombo=heroCombo.replace(/[^2-9TJQKAcdhs]/gi,"").toUpperCase();
  const entry=Object.entries(comboMap as Record<string,unknown>).find(([combo])=>combo.replace(/[^2-9TJQKAcdhs]/gi,"").toUpperCase()===normalizedCombo);
  if(!entry||!Array.isArray(entry[1]))throw new Error(`TexasSolver strategy does not contain combo ${heroCombo}.`);
  const frequencies=entry[1] as unknown[];
  const merged=new Map<PostflopActionType,number>();
  rawActions.forEach((action,index)=>{if(typeof action!=="string"||typeof frequencies[index]!=="number")return;const normalized=normalizeAction(action);if(normalized)merged.set(normalized,(merged.get(normalized)??0)+Number(frequencies[index]));});
  if(!merged.size)throw new Error("TexasSolver action names could not be normalized.");
  return parseSolverResult(JSON.stringify({source:"texassolver",actions:Object.fromEntries(merged)}));
}
export function parseSolverResult(raw:string):SolverResult{
  const value:unknown=JSON.parse(raw);
  if(!value||typeof value!=="object")throw new Error("Solver JSON 객체가 필요합니다.");
  const data=value as Record<string,unknown>;
  let actions:SolverActionResult[]=[];
  if(data.actions&&typeof data.actions==="object"&&!Array.isArray(data.actions)){
    actions=Object.entries(data.actions as Record<string,unknown>).filter(([action,frequency])=>validActions.has(action as PostflopActionType)&&typeof frequency==="number").map(([action,frequency])=>({action:action as PostflopActionType,frequency:Number(frequency)}));
  }else if(Array.isArray(data.strategy)){
    actions=data.strategy.flatMap(item=>{if(!item||typeof item!=="object")return [];const row=item as Record<string,unknown>;return validActions.has(row.action as PostflopActionType)&&typeof row.frequency==="number"?[{action:row.action as PostflopActionType,frequency:Number(row.frequency),ev:typeof row.ev==="number"?row.ev:undefined}]:[];});
  }
  if(!actions.length)throw new Error("actions 또는 strategy 배열에서 액션 빈도를 찾지 못했습니다.");
  const total=actions.reduce((sum,item)=>sum+item.frequency,0);if(total<=0)throw new Error("액션 빈도의 합이 0입니다.");
  actions=actions.map(item=>({...item,frequency:item.frequency/total*100}));
  const requested=typeof data.best_action==="string"?data.best_action:typeof data.bestAction==="string"?data.bestAction:null;
  const bestAction=(requested&&validActions.has(requested as PostflopActionType)?requested:actions.toSorted((a,b)=>b.frequency-a.frequency)[0].action) as PostflopActionType;
  return {source:data.source==="texassolver"?"texassolver":data.source==="openspiel"?"openspiel":"imported",actions,bestAction,exploitability:typeof data.exploitability==="number"?data.exploitability:undefined,evSource:actions.every(action=>typeof action.ev==="number")?"solver":"unavailable"};
}
