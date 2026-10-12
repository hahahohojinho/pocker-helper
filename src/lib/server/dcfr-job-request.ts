import type { PostflopActionType } from "../postflop-machine";
import type { SolverHistoryAction } from "../solver-adapter";
import { validateTexasSolverJob, type TexasSolverJob } from "../texas-solver-config";
import { buildWasmSolveRequest, type WasmHistoryStep, type WasmSolveRequest } from "../wasm-solver/request";

type Role="oop"|"ip";

/** Amounts are BB with two decimals; this absorbs float noise when comparing them. */
const EPSILON=0.005;

interface ReplayedHistory { steps:WasmHistoryStep[];actor:Role;facingBet:boolean; }

const other=(role:Role):Role=>role==="oop"?"ip":"oop";

/**
 * Replays a heads-up street history (actions alternate, OOP first) and rejects anything that does not end at a
 * decision node. `amount` is the actor's street-total commitment in BB, as in RangeLab's postflop machine.
 */
export function replayJobHistory(history:SolverHistoryAction[],stacks:Record<Role,number>):ReplayedHistory{
  const bets={oop:0,ip:0};const steps:WasmHistoryStep[]=[];let actor:Role="oop";let closed=false;
  for(const step of history){
    if(closed)throw new Error("Solver action history continues after the street ended.");
    const toCall=bets[other(actor)]-bets[actor];
    const facing=toCall>EPSILON;
    if(step.action==="fold")throw new Error("Solver action history ends in a fold; there is no decision to solve.");
    if(step.action==="check"){
      if(facing)throw new Error("Solver action history checks while facing a bet.");
      if(step.amount!==undefined&&step.amount>EPSILON)throw new Error("Solver action history check must not commit chips.");
      // Check-check closes the street; the first check passes the action.
      if(actor==="ip")closed=true;
      steps.push({role:actor,action:"check",amount:bets[actor]});
    }else if(step.action==="call"){
      if(!facing)throw new Error("Solver action history calls without a bet to call.");
      bets[actor]=Math.min(bets[other(actor)],stacks[actor]);
      closed=true;
      steps.push({role:actor,action:"call",amount:bets[actor]});
    }else{
      const expected:PostflopActionType=facing?"raise":"bet";
      if(step.action!==expected)throw new Error(`Solver action history uses ${step.action} where only ${expected} is possible.`);
      if(step.amount===undefined||!Number.isFinite(step.amount))throw new Error(`Solver action history ${step.action} needs an amount.`);
      if(step.amount<=bets[other(actor)]+EPSILON)throw new Error(`Solver action history ${step.action} ${step.amount}BB does not exceed the current bet.`);
      if(step.amount>stacks[actor]+EPSILON)throw new Error(`Solver action history ${step.action} ${step.amount}BB exceeds the ${stacks[actor]}BB stack.`);
      if(facing&&bets[other(actor)]>=stacks[other(actor)]-EPSILON)throw new Error("Solver action history raises an all-in bet.");
      // Anything that covers the shorter stack is an effective all-in; the solver tree only has the all-in branch there.
      const coversOpponent=step.amount>=Math.min(stacks.oop,stacks.ip)-EPSILON;
      bets[actor]=coversOpponent?stacks[actor]:step.amount;
      steps.push({role:actor,action:step.action,amount:bets[actor]});
    }
    actor=other(actor);
  }
  if(closed)throw new Error("Solver action history ends the street; there is no decision to solve.");
  return {steps,actor,facingBet:bets[other(actor)]-bets[actor]>EPSILON};
}

/** Street-start stacks per role: from the two players when given, otherwise both at the effective stack. */
function jobStacks(job:TexasSolverJob,actorRole:Role):Record<Role,number>{
  const effective=job.node.effectiveStack;
  if(!job.players)return {oop:effective,ip:effective};
  const actor=job.players.find(player=>player.seat===job.actorSeat)!;
  const opponent=job.players.find(player=>player.seat!==job.actorSeat)!;
  const stacks={[actorRole]:actor.stack,[other(actorRole)]:opponent.stack} as Record<Role,number>;
  if(stacks.oop<=0||stacks.ip<=0)throw new Error("Solver player stacks must be positive.");
  if(Math.abs(Math.min(stacks.oop,stacks.ip)-effective)>EPSILON)throw new Error("Solver player stacks do not match the node's effective stack.");
  return stacks;
}

export interface DcfrJobRequest { request:WasmSolveRequest;legalActions:Set<PostflopActionType>; }

/**
 * Converts a legacy solver job into the native adapter's `--json` request. `node.pot` is the street-start pot; with
 * an action history the decision node comes from the history, so `node.toCall` and `candidateActions` describe the
 * street root only and are not used.
 */
export function buildDcfrJobRequest(job:TexasSolverJob):DcfrJobRequest{
  validateTexasSolverJob(job);
  if(job.players&&job.players.length!==2)throw new Error("Local DCFR adapter supports heads-up jobs only.");
  const history=job.actionHistory??[];
  if(!history.length&&job.node.toCall!==0)throw new Error("A street-root job must have nothing to call; send the action history instead.");
  // Roles alternate from OOP, so the actor's role depends only on the history length.
  const actorRole:Role=history.length%2===0?"oop":"ip";
  const stacks=jobStacks(job,actorRole);
  const replayed=replayJobHistory(history,stacks);
  const request=buildWasmSolveRequest({
    board:job.node.board,heroHole:job.node.heroHole,oopRange:job.ranges.oop,ipRange:job.ranges.ip,
    pot:job.node.pot,stacks,history:replayed.steps,
    iterations:job.iterations,betPercent:job.tree.betPercent,raisePercent:job.tree.raisePercent,
  });
  // The solver result maps an all-in to "bet", so it is allowed alongside raise when facing a bet.
  const legal:PostflopActionType[]=replayed.facingBet?["fold","call","raise","bet"]:["check","bet"];
  const legalActions=new Set(history.length?legal:legal.filter(action=>job.node.candidateActions.includes(action)));
  return {request,legalActions};
}
