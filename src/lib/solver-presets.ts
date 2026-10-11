import type { TexasSolverTree } from "./texas-solver-config";

/** "wasm" is the in-browser DCFR solver; "native" is the same solver multi-threaded behind /api/solver, as are the rest. */
export type SolverBackend="texassolver"|"dcfr"|"counterfactual"|"wasm"|"native";
export type SolverStreet="flop"|"turn"|"river";
export type ExploitabilityLevel="ok"|"warn"|"bad"|"unknown";

export interface SolverPreset { iterations:number;accuracy:number;threads:number;tree:TexasSolverTree;useIsomorphism:boolean;maxClasses:number; }
export interface SolverLogSummary { exploitability?:number;iteration?:number;timeMs?:number; }

/** Requests every thread the server allows; the API clamps it with resolveSolverThreads. */
const MAX_THREADS=32;
const DEFAULT_TIMEOUT_MS=300_000;
const MIN_TIMEOUT_MS=10_000;
const MAX_TIMEOUT_MS=1_800_000;
/** Exploitability thresholds in percent of the pot. */
const OK_EXPLOITABILITY=1;
const WARN_EXPLOITABILITY=5;

/**
 * Iterations are an upper bound: TexasSolver stops early once exploitability reaches `accuracy` percent of the pot.
 * Budgets are uncalibrated against real solve times; tune them with SOLVER_TIMEOUT_MS after a local benchmark.
 */
const budgets:Record<SolverBackend,Record<SolverStreet,{iterations:number;accuracy:number}>>={
  texassolver:{flop:{iterations:200,accuracy:1},turn:{iterations:300,accuracy:0.5},river:{iterations:500,accuracy:0.5}},
  dcfr:{flop:{iterations:300,accuracy:1},turn:{iterations:500,accuracy:0.5},river:{iterations:1000,accuracy:0.5}},
  counterfactual:{flop:{iterations:1000,accuracy:0.5},turn:{iterations:1000,accuracy:0.5},river:{iterations:1000,accuracy:0.3}},
  // Single-threaded in the browser; measured with ~600-combo ranges: river 1000 iterations 0.3s; turn 100 iterations
  // 4s at 0.03% pot exploitability; flop 12 iterations 22s at 1.6%. DCFR has no early stop, so accuracy is informational.
  wasm:{flop:{iterations:20,accuracy:1},turn:{iterations:100,accuracy:0.5},river:{iterations:500,accuracy:0.3}},
  // Native adapter --json with rayon, same ranges: river 1000 in 0.5s; turn 200 in 1.3s at 0.008%; flop 60 in 14s at 0.04%.
  native:{flop:{iterations:60,accuracy:0.5},turn:{iterations:200,accuracy:0.3},river:{iterations:1000,accuracy:0.3}},
};

export function getSolverPreset(backend:SolverBackend,street:SolverStreet):SolverPreset{
  const budget=budgets[backend][street];
  return {
    ...budget,
    threads:MAX_THREADS,
    tree:{betPercent:[50],raisePercent:[60],includeAllIn:false},
    // Off until a native dump confirms exact Hero combos survive isomorphism.
    useIsomorphism:false,
    maxClasses:Number.POSITIVE_INFINITY,
  };
}

const positiveInteger=(value:string|undefined)=>{const parsed=Number(value);return Number.isInteger(parsed)&&parsed>0?parsed:undefined;};

export function resolveSolverThreads(requested:number,configuredMaximum:string|undefined,cpuCount:number){
  const limit=Math.min(MAX_THREADS,positiveInteger(configuredMaximum)??cpuCount,Math.max(1,cpuCount));
  return Math.max(1,Math.min(Number.isInteger(requested)?requested:1,limit));
}

export function resolveSolverTimeoutMs(configured:string|undefined){
  const parsed=positiveInteger(configured);
  return parsed===undefined?DEFAULT_TIMEOUT_MS:Math.min(MAX_TIMEOUT_MS,Math.max(MIN_TIMEOUT_MS,parsed));
}

const finiteNumber=(value:unknown)=>typeof value==="number"&&Number.isFinite(value)?value:undefined;

/** TexasSolver prints one JSON object per report interval; its key is spelled "exploitibility". */
export function parseTexasSolverLog(log:string):SolverLogSummary{
  for(const line of log.split(/\r?\n/).reverse()){
    const text=line.trim();
    if(!text.startsWith("{"))continue;
    let value:unknown;
    try{value=JSON.parse(text);}catch{continue;}
    if(!value||typeof value!=="object")continue;
    const row=value as Record<string,unknown>;
    const exploitability=finiteNumber(row.exploitibility)??finiteNumber(row.exploitability);
    if(exploitability===undefined)continue;
    return {exploitability,iteration:finiteNumber(row.iteration),timeMs:finiteNumber(row.time_ms)};
  }
  return {};
}

export function exploitabilityLevel(percentOfPot:number|undefined):ExploitabilityLevel{
  if(percentOfPot===undefined||!Number.isFinite(percentOfPot))return "unknown";
  if(percentOfPot<=OK_EXPLOITABILITY)return "ok";
  return percentOfPot<=WARN_EXPLOITABILITY?"warn":"bad";
}
