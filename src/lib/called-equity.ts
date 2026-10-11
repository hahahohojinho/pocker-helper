import { calculateRangeEquity } from "./range-equity";
import { scoreRangeOnBoard } from "./range-model";
import { callerSubsets, foldOutcomes, planSubsets, subsetKey, type SubsetEquities } from "./multiway-ev";

/** Relative to the total range weight, below which leftover weight is treated as rounding noise. */
const NEGLIGIBLE_SHARE=1e-9;

type Scored=NonNullable<ReturnType<typeof scoreRangeOnBoard>>[number];

function groupByContinueStrength(scored:Scored[]){
  const groups=new Map<number,Scored[]>();
  for(const item of scored)groups.set(item.continueStrength,[...(groups.get(item.continueStrength)??[]),item]);
  return [...groups].sort((left,right)=>right[0]-left[0]).map(([,items])=>items);
}

/**
 * Removes the weakest `foldShare` of a range's combo weight on this board, ranked by made-hand strength plus draws.
 * Combos with equal strength are trimmed proportionally. Ranges without a complete board are returned unchanged.
 */
export function callingRange(rangeText:string,boardCodes:string[],foldShare:number,deadCodes:string[]=[]){
  if(!Number.isFinite(foldShare)||foldShare<0||foldShare>=1)throw new Error("Fold share must be at least 0 and below 1.");
  const dead=new Set(deadCodes.map(code=>code.toUpperCase()));
  const scored=scoreRangeOnBoard(rangeText,boardCodes)?.filter(item=>item.combo.cards.every(card=>!dead.has(card.toUpperCase())));
  if(!scored?.length||foldShare===0)return rangeText;
  const total=scored.reduce((sum,item)=>sum+item.combo.weight,0);
  let remaining=(1-foldShare)*total;
  const kept:{cards:string;weight:number}[]=[];
  for(const group of groupByContinueStrength(scored)){
    if(remaining<=total*NEGLIGIBLE_SHARE)break;
    const groupWeight=group.reduce((sum,item)=>sum+item.combo.weight,0);
    const ratio=Math.min(1,remaining/groupWeight);
    for(const {combo} of group)kept.push({cards:combo.cards.join(""),weight:combo.weight*ratio});
    remaining-=groupWeight*ratio;
  }
  const maximum=Math.max(...kept.map(item=>item.weight));
  return kept.map(item=>`${item.cards}:${Math.max(0.0001,Math.round(item.weight/maximum*10000)/10000)}`).join(",");
}

/**
 * Hero equity (percent) against opponents restricted to the hands that call a bet with the given fold share,
 * or null when the board is too short to rank continuing hands.
 */
export function estimateEquityWhenCalled(heroCodes:string[],boardCodes:string[],rangeTexts:string[],foldShare:number,iterations=3000):number|null{
  if(scoreRangeOnBoard("AA",boardCodes)===null)return null;
  const ranges=rangeTexts.map(range=>callingRange(range,boardCodes,foldShare,heroCodes));
  return calculateRangeEquity(heroCodes,boardCodes,ranges,iterations).equity;
}

/**
 * Hero equity (percent) against each likely subset of callers, each opponent trimmed to the hands that call with
 * its own fold probability, plus one estimate against every possible caller for the unlikely subsets. Null when the
 * board is too short to rank continuing hands.
 */
export function estimateSubsetEquities(heroCodes:string[],boardCodes:string[],rangeTexts:string[],folds:readonly number[],iterations:number,equity?:(ranges:string[])=>number):SubsetEquities|null{
  if(rangeTexts.length!==folds.length)throw new Error("Each opponent range needs a fold probability.");
  if(scoreRangeOnBoard("AA",boardCodes)===null)return null;
  const equityOf=equity??((ranges:string[])=>calculateRangeEquity(heroCodes,boardCodes,ranges,iterations).equity);
  // An opponent who always folds never calls, so no subset refers to their range.
  const calling=rangeTexts.map((range,index)=>folds[index]>=1?"":callingRange(range,boardCodes,folds[index],heroCodes));
  const plan=planSubsets(callerSubsets(foldOutcomes(folds)));
  const byKey=new Map(plan.exact.map(subset=>[subsetKey(subset.members),equityOf(subset.members.map(index=>calling[index]))] as const));
  const everyone=plan.rest.length?equityOf(calling.filter((_,index)=>folds[index]<1)):null;
  return {byKey,everyone};
}
