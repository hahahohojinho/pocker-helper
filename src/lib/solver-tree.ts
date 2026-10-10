import type { SolverHistoryAction } from "./solver-adapter";
import type { TexasSolverTree } from "./texas-solver-config";

/** Largest size the job validator accepts, as a percent of the pot. */
const MAX_SIZE_PERCENT=500;

/** TexasSolver's console tool builds trees with big_blind=1 and rounds every size to it; RangeLab amounts are in BB. */
export const roundToSolverUnit=(amount:number)=>Math.round(amount);

const roundPercent=(value:number)=>Math.round(value*100)/100;

/**
 * Adds the sizes observed on the current street to the solver tree so the native history path exists.
 * TexasSolver sizes a bet as `round(percent * streetStartPot)` and a raise as `B + round(percent * (streetStartPot + 2B))`,
 * where B is the solver's (rounded) bet being raised; both store the street-total commitment, matching RangeLab amounts.
 */
export function buildSolverTree(base:TexasSolverTree,history:SolverHistoryAction[],streetStartPot:number,allInAmount?:number):TexasSolverTree{
  if(!(streetStartPot>0))throw new Error("Street-start pot must be positive to size the solver tree.");
  const streetBetPercent:number[]=[];const streetRaisePercent:number[]=[];let includeAllIn=base.includeAllIn;let solverBet=0;
  for(const step of history){
    if((step.action!=="bet"&&step.action!=="raise")||step.amount===undefined)continue;
    if(allInAmount!==undefined&&step.amount>=allInAmount){includeAllIn=true;solverBet=allInAmount;continue;}
    const isBet=step.action==="bet";
    const sizingPot=isBet?streetStartPot:streetStartPot+2*solverBet;
    const increment=roundToSolverUnit(step.amount)-(isBet?0:solverBet);
    solverBet=roundToSolverUnit(step.amount);
    if(increment<=0)continue;
    const percent=roundPercent(increment/sizingPot*100);
    if(percent>MAX_SIZE_PERCENT)throw new Error(`Observed ${step.action} ${step.amount}BB is ${percent}% of the pot; the solver tree accepts up to ${MAX_SIZE_PERCENT}%.`);
    const [baseSizes,target]=isBet?[base.betPercent,streetBetPercent]:[base.raisePercent,streetRaisePercent];
    const producesIncrement=(size:number)=>roundToSolverUnit(size/100*sizingPot)===increment;
    if(!baseSizes.some(producesIncrement)&&!target.some(producesIncrement))target.push(percent);
  }
  return {...base,includeAllIn,streetBetPercent:streetBetPercent.toSorted((a,b)=>a-b),streetRaisePercent:streetRaisePercent.toSorted((a,b)=>a-b)};
}
