import type { PreflopScenario } from "./game-state";
import type { Position } from "./preflop";

export type StackBucket = 20 | 40 | 60 | 100 | 150;
export interface StrategyMix { fold: number; passive: number; aggressive: number; source: "baseline-v1"|`dataset:${string}`; }
export interface PreflopSpotContext { openerPosition?:Position;callerPositions?:Position[];actionSize?:number; }
export interface StrategyDatasetRow extends PreflopSpotContext { hand:string;position:Position;stack:StackBucket;scenario:PreflopScenario;fold:number;passive:number;aggressive:number; }
export interface StrategyDataset { contract?:"rangelab.preflop_strategy.v1"|"rangelab.preflop_strategy.v2";id:string;license:string;generatedAt:string;rows:StrategyDatasetRow[]; }
const validPositions=new Set<Position>(["UTG","UTG+1","MP","HJ","CO","BTN","SB","BB"]);
const validStacks=new Set<StackBucket>([20,40,60,100,150]);
const validScenarios=new Set<PreflopScenario>(["unopened","single-open","open-with-callers","facing-3bet","facing-4bet"]);

let activeDataset:StrategyDataset|null=null;
let activeIndex=new Map<string,StrategyDatasetRow[]>();
const positionOrder=["UTG","UTG+1","MP","HJ","CO","BTN","SB","BB"] as Position[];
const normalizedCallers=(positions:Position[])=>[...new Set(positions)].sort((left,right)=>positionOrder.indexOf(left)-positionOrder.indexOf(right));
const baseKey=(row:{hand:string;position:Position;stack:StackBucket;scenario:PreflopScenario})=>`${row.hand}|${row.position}|${row.stack}|${row.scenario}`;
const spotKey=(row:StrategyDatasetRow)=>`${row.position}|${row.stack}|${row.scenario}|${row.openerPosition??"*"}|${row.callerPositions===undefined?"*":normalizedCallers(row.callerPositions).join("+")||"none"}|${row.actionSize??"*"}`;

export function installStrategyDataset(dataset:StrategyDataset){
  if(dataset.contract!==undefined&&!(["rangelab.preflop_strategy.v1","rangelab.preflop_strategy.v2"] as const).includes(dataset.contract))throw new Error("Strategy dataset contract is not supported.");
  if(!/^[a-z0-9][a-z0-9._-]+$/i.test(dataset.id))throw new Error("Strategy dataset id is invalid.");
  if(!dataset.license.trim())throw new Error("Strategy dataset license is required.");
  if(!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(dataset.generatedAt)||Number.isNaN(Date.parse(dataset.generatedAt)))throw new Error("Strategy dataset generatedAt must be a valid ISO date.");
  const groups=new Map<string,Set<string>>();
  for(const row of dataset.rows){
    if(!validPositions.has(row.position))throw new Error(`Invalid position: ${row.position}`);
    if(!validStacks.has(row.stack))throw new Error(`Invalid stack bucket: ${row.stack}`);
    if(!validScenarios.has(row.scenario))throw new Error(`Invalid scenario: ${row.scenario}`);
    if(row.openerPosition!==undefined&&!validPositions.has(row.openerPosition))throw new Error(`Invalid opener position: ${row.openerPosition}`);
    if(row.callerPositions!==undefined&&(row.callerPositions.some(position=>!validPositions.has(position))||new Set(row.callerPositions).size!==row.callerPositions.length))throw new Error("Caller positions must be valid and unique.");
    if(row.actionSize!==undefined&&(!Number.isFinite(row.actionSize)||row.actionSize<=0))throw new Error("Action size must be a positive number.");
    if(dataset.contract==="rangelab.preflop_strategy.v1"&&(row.openerPosition!==undefined||row.callerPositions!==undefined||row.actionSize!==undefined))throw new Error("Strategy v2 spot fields require the v2 contract.");
    const hand=normalizeStartingHand(row.hand);if(!hand)throw new Error(`Invalid starting hand: ${row.hand}`);
    const total=row.fold+row.passive+row.aggressive;
    if([row.fold,row.passive,row.aggressive].some(value=>!Number.isFinite(value)||value<0)||Math.abs(total-100)>0.01)throw new Error(`${row.hand}: frequencies must total 100.`);
    const key=spotKey(row);const hands=groups.get(key)??new Set<string>();
    if(hands.has(hand))throw new Error(`${key} contains duplicate hand ${hand}.`);hands.add(hand);groups.set(key,hands);
  }
  for(const [key,hands] of groups)if(hands.size!==169)throw new Error(`${key} must contain all 169 starting hands.`);
  if(!groups.size)throw new Error("Strategy dataset is empty.");
  activeDataset={...dataset,rows:dataset.rows.map(row=>({...row,hand:normalizeStartingHand(row.hand)!,callerPositions:row.callerPositions===undefined?undefined:normalizedCallers(row.callerPositions)}))};
  activeIndex=new Map();for(const row of activeDataset.rows){const key=baseKey(row);activeIndex.set(key,[...(activeIndex.get(key)??[]),row]);}
}

export function parseStrategyDatasetJson(text:string):StrategyDataset{
  if(text.length>5_000_000)throw new Error("Strategy dataset exceeds the 5 MB limit.");
  let value:unknown;try{value=JSON.parse(text);}catch{throw new Error("Strategy dataset is not valid JSON.");}
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Strategy dataset must be a JSON object.");
  const data=value as Record<string,unknown>;
  if(typeof data.id!=="string"||typeof data.license!=="string"||typeof data.generatedAt!=="string"||!Array.isArray(data.rows))throw new Error("Dataset requires id, license, generatedAt, and rows.");
  const rows=data.rows.map((value,index)=>{
    if(!value||typeof value!=="object"||Array.isArray(value))throw new Error(`Row ${index+1} must be an object.`);
    const row=value as Record<string,unknown>;
    if(typeof row.hand!=="string"||typeof row.position!=="string"||typeof row.stack!=="number"||typeof row.scenario!=="string"||typeof row.fold!=="number"||typeof row.passive!=="number"||typeof row.aggressive!=="number"||(row.openerPosition!==undefined&&typeof row.openerPosition!=="string")||(row.callerPositions!==undefined&&(!Array.isArray(row.callerPositions)||row.callerPositions.some(position=>typeof position!=="string")))||(row.actionSize!==undefined&&typeof row.actionSize!=="number"))throw new Error(`Row ${index+1} has missing or invalid fields.`);
    return row as unknown as StrategyDatasetRow;
  });
  const contract=data.contract;if(contract!==undefined&&contract!=="rangelab.preflop_strategy.v1"&&contract!=="rangelab.preflop_strategy.v2")throw new Error("Strategy dataset contract is not supported.");
  const dataset={contract:contract as StrategyDataset["contract"],id:data.id,license:data.license,generatedAt:data.generatedAt,rows};
  installStrategyDataset(dataset);
  return dataset;
}

export function clearStrategyDataset(){activeDataset=null;activeIndex=new Map();}
export function activeStrategyDataset(){return activeDataset&&{id:activeDataset.id,contract:activeDataset.contract??"rangelab.preflop_strategy.v1",license:activeDataset.license,generatedAt:activeDataset.generatedAt,spots:new Set(activeDataset.rows.map(spotKey)).size};}

const ranks = "AKQJT98765432";
const positionWidth: Record<Position, number> = { UTG:0,"UTG+1":2,MP:4,HJ:6,CO:10,BTN:15,SB:12,BB:14 };
const scenarioTightness: Record<PreflopScenario, number> = { unopened:-7,"single-open":0,"open-with-callers":2,"facing-3bet":12,"facing-4bet":23 };

export const allStartingHands = ranks.split("").flatMap((high, row) =>
  ranks.split("").map((low, column) => row === column ? `${high}${low}` : row < column ? `${high}${low}s` : `${low}${high}o`)
);

export function normalizeStartingHand(raw: string) {
  const text = raw.toUpperCase().replace(/[^AKQJT2-9SO]/g, "");
  if (text.length < 2 || !ranks.includes(text[0]) || !ranks.includes(text[1])) return null;
  if (text[0] === text[1]) return `${text[0]}${text[1]}`;
  const [high, low] = ranks.indexOf(text[0]) < ranks.indexOf(text[1]) ? [text[0], text[1]] : [text[1], text[0]];
  return `${high}${low}${text[2] === "O" ? "o" : "s"}`;
}

export function nearestStackBucket(stack: number): StackBucket {
  return ([20,40,60,100,150] as StackBucket[]).reduce((best, value) => Math.abs(value-stack) < Math.abs(best-stack) ? value : best, 100);
}

function strength(hand: string) {
  const first = ranks.indexOf(hand[0]);
  const second = ranks.indexOf(hand[1]);
  const pair = hand[0] === hand[1];
  const suited = hand.endsWith("s");
  const gap = Math.abs(first-second);
  let value = 100-first*5-second*2.2;
  if(pair)value += 28-first*1.5;
  if(suited)value += 6;
  if(!pair&&gap<=3)value += 5-gap;
  if(hand[0]==="A")value += 5;
  return value;
}

export function lookupStrategy(input:{hand:string;position:Position;stack:number;scenario:PreflopScenario}&PreflopSpotContext):StrategyMix {
  const hand=normalizeStartingHand(input.hand);
  if(!hand)return {fold:100,passive:0,aggressive:0,source:"baseline-v1"};
  const bucket=nearestStackBucket(input.stack);
  const inputCallers=normalizedCallers(input.callerPositions??[]);
  const candidates=activeIndex.get(baseKey({hand,position:input.position,stack:bucket,scenario:input.scenario}))??[];
  const datasetRow=candidates.filter(row=>(row.openerPosition===undefined||row.openerPosition===input.openerPosition)&&(row.callerPositions===undefined||normalizedCallers(row.callerPositions).join("|")===inputCallers.join("|"))&&(row.actionSize===undefined||input.actionSize!==undefined)).toSorted((left,right)=>{
    const specificity=(row:StrategyDatasetRow)=>(row.openerPosition===undefined?0:4)+(row.callerPositions===undefined?0:2)+(row.actionSize===undefined?0:1);
    const specificityDifference=specificity(right)-specificity(left);if(specificityDifference)return specificityDifference;
    return Math.abs((left.actionSize??input.actionSize??0)-(input.actionSize??0))-Math.abs((right.actionSize??input.actionSize??0)-(input.actionSize??0));
  })[0];
  if(datasetRow)return {fold:datasetRow.fold,passive:datasetRow.passive,aggressive:datasetRow.aggressive,source:`dataset:${activeDataset!.id}`};
  const stackAdjustment=bucket<=20?5:bucket<=40?3:bucket>=150?-2:0;
  const score=strength(hand)+positionWidth[input.position]+stackAdjustment-scenarioTightness[input.scenario];
  if(score>=118)return {fold:0,passive:10,aggressive:90,source:"baseline-v1"};
  if(score>=105)return {fold:5,passive:40,aggressive:55,source:"baseline-v1"};
  if(score>=92)return {fold:15,passive:65,aggressive:20,source:"baseline-v1"};
  if(score>=80)return {fold:45,passive:48,aggressive:7,source:"baseline-v1"};
  if(score>=70)return {fold:75,passive:23,aggressive:2,source:"baseline-v1"};
  return {fold:96,passive:4,aggressive:0,source:"baseline-v1"};
}

export function buildStrategyMatrix(position:Position,stack:number,scenario:PreflopScenario,context:PreflopSpotContext={}){
  return allStartingHands.map(hand=>({hand,...lookupStrategy({hand,position,stack,scenario,...context})}));
}
