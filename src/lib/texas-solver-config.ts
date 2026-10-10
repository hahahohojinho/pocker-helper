import type { SolverHistoryAction, SolverNodeV1 } from "./solver-adapter";

export interface TexasSolverRanges { oop:string; ip:string; }
/** street* sizes are added only on the solved street, where they reproduce sizes observed in the action history. */
export interface TexasSolverTree { betPercent:number[]; raisePercent:number[]; includeAllIn:boolean; streetBetPercent?:number[]; streetRaisePercent?:number[]; }
export interface SolverPlayerRange { seat:number;range:string;stack:number; }
export interface TexasSolverJob { node:SolverNodeV1; ranges:TexasSolverRanges; tree:TexasSolverTree; accuracy:number; iterations:number; threads:number; useIsomorphism?:boolean; actionHistory?:SolverHistoryAction[]; players?:SolverPlayerRange[];actorSeat?:number; }

const safeRange=/^[A0-9TJQKOsocdhs,:. ]+$/i;
const finitePositive=(value:number)=>Number.isFinite(value)&&value>0;
const MAX_SIZES_PER_LIST=8;
const mergedSizes=(base:number[],street:number[]=[])=>[...new Set([...base,...street])];

export function validateTexasSolverJob(job:TexasSolverJob){
  const expectedCards={flop:3,turn:4,river:5}[job.node.street];
  if(job.node.board.length!==expectedCards)throw new Error(`${job.node.street} solver job requires ${expectedCards} board cards.`);
  if(!safeRange.test(job.ranges.oop)||!safeRange.test(job.ranges.ip)||job.ranges.oop.includes("\n")||job.ranges.ip.includes("\n"))throw new Error("Range 문자열에 허용되지 않은 문자가 있습니다.");
  if(!finitePositive(job.node.pot)||!finitePositive(job.node.effectiveStack))throw new Error("Pot과 effective stack은 양수여야 합니다.");
  if(!finitePositive(job.accuracy)||job.accuracy>10)throw new Error("Accuracy는 0 초과 10 이하만 허용합니다.");
  if(!Number.isInteger(job.iterations)||job.iterations<1||job.iterations>5000)throw new Error("Iterations는 1~5000 범위여야 합니다.");
  if(!Number.isInteger(job.threads)||job.threads<1||job.threads>32)throw new Error("Threads는 1~32 범위여야 합니다.");
  const sizeLists=[job.tree.betPercent,job.tree.raisePercent,job.tree.streetBetPercent??[],job.tree.streetRaisePercent??[]];
  if(sizeLists.some(list=>!Array.isArray(list)||list.length>MAX_SIZES_PER_LIST))throw new Error(`Bet/Raise size 목록은 최대 ${MAX_SIZES_PER_LIST}개입니다.`);
  for(const size of sizeLists.flat())if(!finitePositive(size)||size>500)throw new Error("Bet/Raise size는 0 초과 500 이하의 팟 비율이어야 합니다.");
  if([mergedSizes(job.tree.betPercent,job.tree.streetBetPercent),mergedSizes(job.tree.raisePercent,job.tree.streetRaisePercent)].some(list=>list.length>MAX_SIZES_PER_LIST))throw new Error(`스트리트별 Bet/Raise size는 최대 ${MAX_SIZES_PER_LIST}개입니다.`);
  if(job.actionHistory){
    if(job.actionHistory.length>20)throw new Error("Solver action history exceeds 20 actions.");
    const validActions=new Set(["fold","check","bet","call","raise"]);
    for(const step of job.actionHistory)if(!validActions.has(step.action)||(step.amount!==undefined&&(!Number.isFinite(step.amount)||step.amount<0)))throw new Error("Solver action history is invalid.");
  }
  if(job.players){
    if(job.players.length<2||job.players.length>8)throw new Error("Solver players must contain 2 to 8 seats.");
    if(new Set(job.players.map(player=>player.seat)).size!==job.players.length)throw new Error("Solver player seats must be unique.");
    for(const player of job.players)if(!Number.isInteger(player.seat)||player.seat<0||!Number.isFinite(player.stack)||player.stack<0||!safeRange.test(player.range)||player.range.includes("\n"))throw new Error("Solver player range is invalid.");
    if(job.actorSeat===undefined||!job.players.some(player=>player.seat===job.actorSeat))throw new Error("Solver actorSeat must identify a player.");
  }
}

export function buildTexasSolverCommands(job:TexasSolverJob,outputFile="output_result.json"){
  validateTexasSolverJob(job);
  const board=job.node.board.map(card=>`${card[0].toUpperCase()}${card[1].toLowerCase()}`).join(",");
  const lines=[
    `set_pot ${job.node.pot}`,
    `set_effective_stack ${job.node.effectiveStack}`,
    `set_board ${board}`,
    `set_range_ip ${job.ranges.ip}`,
    `set_range_oop ${job.ranges.oop}`,
  ];
  for(const actor of ["oop","ip"]){
    for(const street of ["flop","turn","river"]){
      const solvedStreet=street===job.node.street;
      const betSizes=mergedSizes(job.tree.betPercent,solvedStreet?job.tree.streetBetPercent:[]);
      const raiseSizes=mergedSizes(job.tree.raisePercent,solvedStreet?job.tree.streetRaisePercent:[]);
      if(betSizes.length)lines.push(`set_bet_sizes ${actor},${street},bet,${betSizes.join(",")}`);
      if(raiseSizes.length)lines.push(`set_bet_sizes ${actor},${street},raise,${raiseSizes.join(",")}`);
      if(job.tree.includeAllIn)lines.push(`set_bet_sizes ${actor},${street},allin`);
    }
  }
  lines.push("set_allin_threshold 1.0","build_tree",`set_thread_num ${job.threads}`,`set_accuracy ${job.accuracy}`,`set_max_iteration ${job.iterations}`,`set_print_interval ${Math.max(1,Math.floor(job.iterations/10))}`,`set_use_isomorphism ${job.useIsomorphism?1:0}`,"start_solve","set_dump_rounds 2",`dump_result ${outputFile}`);
  return `${lines.join("\n")}\n`;
}
