import type { SolverNodeV1 } from "./solver-adapter";

export interface TexasSolverRanges { oop:string; ip:string; }
export interface TexasSolverTree { betPercent:number[]; raisePercent:number[]; includeAllIn:boolean; }
export interface TexasSolverJob { node:SolverNodeV1; ranges:TexasSolverRanges; tree:TexasSolverTree; accuracy:number; iterations:number; threads:number; }

const safeRange=/^[A0-9TJQKOsocdhs,:.\s]+$/i;
const finitePositive=(value:number)=>Number.isFinite(value)&&value>0;

export function validateTexasSolverJob(job:TexasSolverJob){
  const expectedCards={flop:3,turn:4,river:5}[job.node.street];
  if(job.node.board.length!==expectedCards)throw new Error(`${job.node.street} solver job requires ${expectedCards} board cards.`);
  if(!safeRange.test(job.ranges.oop)||!safeRange.test(job.ranges.ip)||job.ranges.oop.includes("\n")||job.ranges.ip.includes("\n"))throw new Error("Range 문자열에 허용되지 않은 문자가 있습니다.");
  if(!finitePositive(job.node.pot)||!finitePositive(job.node.effectiveStack))throw new Error("Pot과 effective stack은 양수여야 합니다.");
  if(!finitePositive(job.accuracy)||job.accuracy>10)throw new Error("Accuracy는 0 초과 10 이하만 허용합니다.");
  if(!Number.isInteger(job.iterations)||job.iterations<1||job.iterations>5000)throw new Error("Iterations는 1~5000 범위여야 합니다.");
  if(!Number.isInteger(job.threads)||job.threads<1||job.threads>32)throw new Error("Threads는 1~32 범위여야 합니다.");
  for(const size of [...job.tree.betPercent,...job.tree.raisePercent])if(!finitePositive(size)||size>500)throw new Error("Bet/Raise size는 0 초과 500 이하의 팟 비율이어야 합니다.");
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
      if(job.tree.betPercent.length)lines.push(`set_bet_sizes ${actor},${street},bet,${job.tree.betPercent.join(",")}`);
      if(job.tree.raisePercent.length)lines.push(`set_bet_sizes ${actor},${street},raise,${job.tree.raisePercent.join(",")}`);
      if(job.tree.includeAllIn)lines.push(`set_bet_sizes ${actor},${street},allin`);
    }
  }
  lines.push("set_allin_threshold 1.0","build_tree",`set_thread_num ${job.threads}`,`set_accuracy ${job.accuracy}`,`set_max_iteration ${job.iterations}`,"set_print_interval 10","set_use_isomorphism 0","start_solve","set_dump_rounds 2",`dump_result ${outputFile}`);
  return `${lines.join("\n")}\n`;
}
