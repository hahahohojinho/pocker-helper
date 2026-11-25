import type { SolverHistoryAction, SolverNodeV1 } from "./solver-adapter";
import { parseCard } from "./equity";

export interface TexasSolverRanges { oop:string; ip:string; }
export interface TexasSolverTree { betPercent:number[]; raisePercent:number[]; includeAllIn:boolean; }
export interface SolverPlayerRange { seat:number;range:string;stack:number; }
export interface TexasSolverJob { node:SolverNodeV1; ranges:TexasSolverRanges; tree:TexasSolverTree; accuracy:number; iterations:number; threads:number; actionHistory?:SolverHistoryAction[]; players?:SolverPlayerRange[];actorSeat?:number; }

const safeRange=/^[A0-9TJQKOsocdhs,:. ]+$/i;
const MAX_RANGE_LENGTH=65_536;
const MAX_TREE_SIZES=8;
const MAX_CHIP_AMOUNT=1_000_000;
const isSafeRange=(range:unknown)=>typeof range==="string"&&range.length<=MAX_RANGE_LENGTH&&safeRange.test(range);
const finitePositive=(value:number)=>Number.isFinite(value)&&value>0;
const validActions=new Set(["fold","check","bet","call","raise"]);
const isCardCode=(card:unknown)=>typeof card==="string"&&/^[2-9TJQKA][cdhs]$/i.test(card)&&parseCard(card)!==null;

export function validateTexasSolverJob(job:TexasSolverJob){
  if(!job||typeof job!=="object"||!job.node||!job.ranges||!job.tree)throw new Error("Solver job 형식이 올바르지 않습니다.");
  const expectedCards=({flop:3,turn:4,river:5} as Record<string,number>)[job.node.street];
  if(!expectedCards)throw new Error("Solver street는 flop, turn, river 중 하나여야 합니다.");
  if(!Array.isArray(job.node.board)||job.node.board.length!==expectedCards)throw new Error(`${job.node.street} solver job requires ${expectedCards} board cards.`);
  if(!Array.isArray(job.node.heroHole)||job.node.heroHole.length!==2)throw new Error("Hero 카드는 정확히 2장이어야 합니다.");
  const cards=[...job.node.heroHole,...job.node.board];
  if(!cards.every(isCardCode))throw new Error("Hero 카드와 보드 카드 형식을 확인하세요.");
  if(new Set(cards.map(card=>card.toUpperCase())).size!==cards.length)throw new Error("같은 카드를 두 번 사용할 수 없습니다.");
  if(!Array.isArray(job.node.candidateActions)||!job.node.candidateActions.length||job.node.candidateActions.some(action=>!validActions.has(action)))throw new Error("Solver candidateActions가 올바르지 않습니다.");
  if(!isSafeRange(job.ranges.oop)||!isSafeRange(job.ranges.ip))throw new Error("Range 문자열에 허용되지 않은 문자가 있습니다.");
  if(!finitePositive(job.node.pot)||!finitePositive(job.node.effectiveStack)||job.node.pot>MAX_CHIP_AMOUNT||job.node.effectiveStack>MAX_CHIP_AMOUNT)throw new Error("Pot과 effective stack은 0 초과 1,000,000 이하여야 합니다.");
  if(!Number.isFinite(job.node.toCall)||job.node.toCall<0||job.node.toCall>MAX_CHIP_AMOUNT)throw new Error("Call 금액은 0 이상 1,000,000 이하여야 합니다.");
  if(!Array.isArray(job.tree.betPercent)||!Array.isArray(job.tree.raisePercent)||job.tree.betPercent.length>MAX_TREE_SIZES||job.tree.raisePercent.length>MAX_TREE_SIZES)throw new Error(`Bet/Raise size 목록은 각각 ${MAX_TREE_SIZES}개 이하의 배열이어야 합니다.`);
  if(!finitePositive(job.accuracy)||job.accuracy>10)throw new Error("Accuracy는 0 초과 10 이하만 허용합니다.");
  if(!Number.isInteger(job.iterations)||job.iterations<1||job.iterations>5000)throw new Error("Iterations는 1~5000 범위여야 합니다.");
  if(!Number.isInteger(job.threads)||job.threads<1||job.threads>32)throw new Error("Threads는 1~32 범위여야 합니다.");
  for(const size of [...job.tree.betPercent,...job.tree.raisePercent])if(!finitePositive(size)||size>500)throw new Error("Bet/Raise size는 0 초과 500 이하의 팟 비율이어야 합니다.");
  if(job.actionHistory!==undefined){
    if(!Array.isArray(job.actionHistory))throw new Error("Solver action history is invalid.");
    if(job.actionHistory.length>20)throw new Error("Solver action history exceeds 20 actions.");
    for(const step of job.actionHistory)if(!step||typeof step!=="object"||!validActions.has(step.action)||(step.amount!==undefined&&(!Number.isFinite(step.amount)||step.amount<0)))throw new Error("Solver action history is invalid.");
  }
  if(job.players!==undefined){
    if(!Array.isArray(job.players)||job.players.length<2||job.players.length>8)throw new Error("Solver players must contain 2 to 8 seats.");
    for(const player of job.players)if(!player||typeof player!=="object"||!Number.isInteger(player.seat)||player.seat<0||!Number.isFinite(player.stack)||player.stack<0||player.stack>MAX_CHIP_AMOUNT||!isSafeRange(player.range))throw new Error("Solver player range is invalid.");
    if(new Set(job.players.map(player=>player.seat)).size!==job.players.length)throw new Error("Solver player seats must be unique.");
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
      if(job.tree.betPercent.length)lines.push(`set_bet_sizes ${actor},${street},bet,${job.tree.betPercent.join(",")}`);
      if(job.tree.raisePercent.length)lines.push(`set_bet_sizes ${actor},${street},raise,${job.tree.raisePercent.join(",")}`);
      if(job.tree.includeAllIn)lines.push(`set_bet_sizes ${actor},${street},allin`);
    }
  }
  lines.push("set_allin_threshold 1.0","build_tree",`set_thread_num ${job.threads}`,`set_accuracy ${job.accuracy}`,`set_max_iteration ${job.iterations}`,"set_print_interval 10","set_use_isomorphism 0","start_solve","set_dump_rounds 2",`dump_result ${outputFile}`);
  return `${lines.join("\n")}\n`;
}
