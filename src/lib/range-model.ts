import type { PlayerAction, PreflopScenario } from "./game-state";
import { classifyPreflop, derivePreflopSpotContext } from "./game-state";
import type { Position } from "./preflop";
import { allStartingHands, lookupStrategy } from "./strategy-data";
import { normalizeStartingHand } from "./strategy-data";
import { bestHandScore, parseCard } from "./equity";
import { parseWeightedRange } from "./range-equity";
import type { PostflopActionType } from "./postflop-machine";

export interface InferredRange {
  text: string;
  handCount: number;
  source: "action-baseline-v1";
}

function actionProbability(type: PlayerAction["type"], amount: number, scenario: PreflopScenario, mix: ReturnType<typeof lookupStrategy>) {
  if (type === "fold") return mix.fold;
  const benchmark = scenario === "unopened" ? 2.5 : scenario === "single-open" || scenario === "open-with-callers" ? 8 : scenario === "facing-3bet" ? 22 : 50;
  const pressure = Math.max(0, amount / benchmark - 1);
  if (["open", "3bet", "4bet", "5bet"].includes(type)) {
    const strengthTilt = 0.55 + mix.aggressive / 100;
    return mix.aggressive * Math.pow(strengthTilt, pressure);
  }
  const continuation = (mix.passive + mix.aggressive) / 100;
  return mix.passive * Math.pow(0.5 + continuation / 2, pressure);
}

function scenarioBefore(actions: PlayerAction[], index: number): PreflopScenario {
  return classifyPreflop(actions.slice(0, index));
}

/** Converts observed actions to a weighted baseline range; it is not solver GTO data. */
export function inferRangeFromPreflop(input: { actions: PlayerAction[]; seat: number; position: Position; stack: number }): InferredRange {
  const observations = input.actions.map((action, index) => ({ action, index }))
    .filter(({ action }) => action.seat === input.seat && action.type !== "fold");
  const scores = allStartingHands.map(hand => {
    let score = 1;
    for (const { action, index } of observations) {
      const priorActions=input.actions.slice(0,index);
      const mix = lookupStrategy({ hand, position: input.position, stack: input.stack, scenario: scenarioBefore(input.actions, index),...derivePreflopSpotContext(priorActions) });
      score *= actionProbability(action.type, action.amount, scenarioBefore(input.actions, index), mix) / 100;
    }
    return { hand, score };
  });
  const maximum = Math.max(...scores.map(item => item.score), 0);
  const kept = scores.map(item => ({ ...item, weight: maximum > 0 ? item.score / maximum : 0 }))
    .filter(item => item.weight >= 0.01);
  const fallback = kept.length ? kept : [{ ...scores[0], weight: 1 }];
  return {
    text: fallback.map(item => `${item.hand}:${Math.max(0.01, Math.round(item.weight * 100) / 100)}`).join(","),
    handCount: fallback.length,
    source: "action-baseline-v1",
  };
}

/** Applies board-aware made-hand, draw, and blocker heuristics to an already weighted range. */
export function conditionRangeOnPostflop(input:{rangeText:string;boardCodes:string[];actions:PostflopActionType[]}):string{
  if(input.boardCodes.length<3||!input.actions.length)return input.rangeText;
  const board=input.boardCodes.map(parseCard);
  if(board.some(card=>!card))return input.rangeText;
  const boardCards=board.filter(card=>card!==null);
  const combos=parseWeightedRange(input.rangeText).filter(combo=>{
    const codes=new Set([...input.boardCodes.map(card=>card.toUpperCase()),...combo.cards.map(card=>card.toUpperCase())]);
    return codes.size===input.boardCodes.length+2;
  }).map(combo=>{const holeCards=combo.cards.map(card=>parseCard(card)!);const cards=[...holeCards,...boardCards];return {combo,score:bestHandScore(cards),draw:drawPotential(cards,input.boardCodes.length),blocker:blockerPotential(holeCards,boardCards)};});
  if(!combos.length)return input.rangeText;
  const orderedScores=[...new Set(combos.map(item=>item.score))].sort((a,b)=>a-b);
  const scorePercentile=new Map(orderedScores.map((score,index)=>[score,orderedScores.length===1?1:index/(orderedScores.length-1)]));
  const weighted=combos.map(({combo,score,draw,blocker})=>{
    const strength=scorePercentile.get(score)??0.5;
    const continueStrength=Math.min(1,strength+draw);
    const aggressionStrength=Math.min(1,continueStrength+blocker*(1-continueStrength));
    let weight=combo.weight;
    for(const action of input.actions){
      if(action==="bet"||action==="raise")weight*=0.2+0.8*aggressionStrength;
      else if(action==="call")weight*=0.45+0.55*(1-Math.abs(continueStrength-0.7));
      else if(action==="check")weight*=1-0.35*strength;
    }
    return {combo,weight};
  });
  const maximum=Math.max(...weighted.map(item=>item.weight));
  return weighted.filter(item=>item.weight/maximum>=0.01).map(item=>`${item.combo.cards.join("")}:${Math.max(0.01,Math.round(item.weight/maximum*100)/100)}`).join(",");
}

function blockerPotential(holeCards:NonNullable<ReturnType<typeof parseCard>>[],boardCards:NonNullable<ReturnType<typeof parseCard>>[]){
  let value=0;
  const boardSuitCounts=new Map<string,number>();for(const card of boardCards)boardSuitCounts.set(card.suit,(boardSuitCounts.get(card.suit)??0)+1);
  for(const [suit,count] of boardSuitCounts){
    if(count<3)continue;
    const boardRanks=new Set(boardCards.filter(card=>card.suit===suit).map(card=>card.rank));
    let nutRank=14;while(boardRanks.has(nutRank)&&nutRank>=2)nutRank--;
    if(holeCards.some(card=>card.suit===suit&&card.rank===nutRank))value=Math.max(value,0.2);
  }
  const boardRanks=new Set(boardCards.map(card=>card.rank));if(boardRanks.has(14))boardRanks.add(1);
  for(let low=1;low<=10;low++){
    const missing:number[]=[];for(let rank=low;rank<low+5;rank++)if(!boardRanks.has(rank))missing.push(rank);
    if(missing.length===2&&holeCards.some(card=>missing.includes(card.rank===14?1:card.rank)))value=Math.max(value,0.08);
  }
  return value;
}

function drawPotential(cards:NonNullable<ReturnType<typeof parseCard>>[],boardCount:number){
  if(boardCount>=5)return 0;
  const suitCounts=new Map<string,number>();for(const card of cards)suitCounts.set(card.suit,(suitCounts.get(card.suit)??0)+1);
  const flushDraw=[...suitCounts.values()].some(count=>count===4);
  const ranks=new Set(cards.map(card=>card.rank));if(ranks.has(14))ranks.add(1);
  let straightDraw=false;for(let low=1;low<=10;low++){let present=0;for(let rank=low;rank<low+5;rank++)if(ranks.has(rank))present++;if(present===4){straightDraw=true;break;}}
  return (flushDraw?0.28:0)+(straightDraw?0.2:0);
}

export function ensureComboInRange(rangeText:string,holeCards:string[],minimumWeight=0.01){
  if(holeCards.length!==2)throw new Error("Two hole cards are required.");
  const target=holeCards.map(card=>parseCard(card)?.code).filter(Boolean) as string[];
  if(target.length!==2||target[0]===target[1])throw new Error("Hole cards are invalid or duplicated.");
  const targetKey=[...target].sort().join("").toUpperCase();
  const contains=parseWeightedRange(rangeText).some(combo=>[...combo.cards].sort().join("").toUpperCase()===targetKey);
  return contains?rangeText:`${rangeText},${target.join("")}:${minimumWeight}`;
}

/** TexasSolver v0.2.0 accepts weighted 169 classes, not exact suit combos. */
export function toTexasSolverRange(rangeText:string,requiredHoleCards?:string[],minimumWeight=0.01,maxClasses=Number.POSITIVE_INFINITY){
  const grouped=new Map<string,{weight:number;count:number}>();
  for(const combo of parseWeightedRange(rangeText)){
    const first=parseCard(combo.cards[0])!;const second=parseCard(combo.cards[1])!;
    const suffix=first.rank===second.rank?"":first.suit===second.suit?"s":"o";
    const hand=normalizeStartingHand(`${"--23456789TJQKA"[first.rank]}${"--23456789TJQKA"[second.rank]}${suffix}`)!;
    const current=grouped.get(hand)??{weight:0,count:0};current.weight+=combo.weight;current.count++;grouped.set(hand,current);
  }
  let requiredHand:string|undefined;
  if(requiredHoleCards){
    const cards=requiredHoleCards.map(parseCard);if(cards.length!==2||cards.some(card=>!card))throw new Error("Required hole cards are invalid.");
    const [first,second]=cards as NonNullable<ReturnType<typeof parseCard>>[];const suffix=first.rank===second.rank?"":first.suit===second.suit?"s":"o";
    requiredHand=normalizeStartingHand(`${"--23456789TJQKA"[first.rank]}${"--23456789TJQKA"[second.rank]}${suffix}`)!;
    if(!grouped.has(requiredHand))grouped.set(requiredHand,{weight:minimumWeight,count:1});
  }
  const ranked=[...grouped].map(([hand,value])=>({hand,weight:Math.max(minimumWeight,Math.round(value.weight/value.count*1000)/1000)})).sort((a,b)=>b.weight-a.weight);
  let selected=ranked.slice(0,Math.max(1,Math.floor(maxClasses)));
  if(requiredHand&&!selected.some(item=>item.hand===requiredHand))selected=[...selected.slice(0,-1),ranked.find(item=>item.hand===requiredHand)!];
  return selected.map(item=>`${item.hand}:${item.weight}`).join(",");
}
