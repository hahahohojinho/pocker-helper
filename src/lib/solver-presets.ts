import type { TexasSolverTree } from "./texas-solver-config";

/**
 * "wasm" is the in-browser DCFR solver; "native" is the same solver multi-threaded behind /api/solver, as are the rest.
 * "multiway" is the adapter's 3-player river mode (`--json-multiway`).
 */
export type SolverBackend="texassolver"|"dcfr"|"counterfactual"|"wasm"|"native"|"multiway";
export type SolverStreet="flop"|"turn"|"river";
export type ExploitabilityLevel="ok"|"warn"|"bad"|"unknown";

export interface StreetSizes { betPercent:number[];raisePercent:number[]; }
/** Bet sizes for streets after the solved one. A later street without sizes is check-only (all-in at SPR <= 1). */
export interface LaterStreetSizes { river?:StreetSizes; }
/** For DCFR backends `timeBudgetMs` bounds wall-clock time and `iterations` is only a cap. */
export interface SolverPreset { iterations:number;accuracy:number;timeBudgetMs?:number;threads:number;tree:TexasSolverTree;laterStreets?:LaterStreetSizes;
  /** DCFR all-in rule: offered when the stack is at most this many pots; unset keeps the solver default (1). */
  allInPotRatio?:number;useIsomorphism:boolean;maxClasses:number; }
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
/** Leaves headroom inside the 5 s answer target for range building, the request, and rendering. */
const DCFR_TIME_BUDGET_MS=4500;
/**
 * Native flops outside the library get most of the 10 s answer limit: one wide-range flop iteration takes ~0.6 s.
 * 2026-10-17, 12 threads, BTN/CO vs BB SRP ranges, 4 boards: 4.5s 3-6 iterations at 4.6-17.9% exploitability;
 * 8s 7-12 at 1.0-7.2%; 9s 8-15 at 0.8-4.6% (adapter wall 7.8-8.6s). The library (30 s per flop) reaches <=0.5%.
 */
const NATIVE_FLOP_BUDGET_MS=9000;
/** 3-way turns (river check-down model) need ~0.23 s per iteration; 8 s reaches the 1% "ok" level on SRP ranges. */
const MULTIWAY_TURN_BUDGET_MS=8000;
/**
 * 2026-11-27, 12 threads, 132 spots (5 pot types, 6 boards), 4.5 s: first-to-act turns 0.04-0.25%, rivers 0.01-0.17%;
 * turns facing an off-tree 75%/125% bet 0.43-0.95% (49-74 iterations); SRP rivers facing a raise 0.58-0.71%
 * (153-163). 8.5 s keeps the answer inside the 10 s limit (server cap SOLVER_MAX_BUDGET_MS).
 */
const NATIVE_FACING_BUDGET_MS=8500;
const NATIVE_BUDGETS={flop:{iterations:300,accuracy:0.5,timeBudgetMs:NATIVE_FLOP_BUDGET_MS},turn:{iterations:500,accuracy:0.3,timeBudgetMs:DCFR_TIME_BUDGET_MS},river:{iterations:1000,accuracy:0.3,timeBudgetMs:DCFR_TIME_BUDGET_MS}};
const budgets:Record<SolverBackend,Record<SolverStreet,{iterations:number;accuracy:number;timeBudgetMs?:number}>>={
  texassolver:{flop:{iterations:200,accuracy:1},turn:{iterations:300,accuracy:0.5},river:{iterations:500,accuracy:0.5}},
  dcfr:{flop:{iterations:300,accuracy:1},turn:{iterations:500,accuracy:0.5},river:{iterations:1000,accuracy:0.5}},
  counterfactual:{flop:{iterations:1000,accuracy:0.5},turn:{iterations:1000,accuracy:0.5},river:{iterations:1000,accuracy:0.3}},
  // Single-threaded in the browser; measured with ~600-combo ranges: river 1000 iterations 0.3s; turn 100 iterations
  // 4s at 0.03% pot exploitability; flop 12 iterations 22s at 1.6%. DCFR has no early stop, so accuracy is informational.
  wasm:{flop:{iterations:100,accuracy:1,timeBudgetMs:DCFR_TIME_BUDGET_MS},turn:{iterations:300,accuracy:0.5,timeBudgetMs:DCFR_TIME_BUDGET_MS},river:{iterations:500,accuracy:0.3,timeBudgetMs:DCFR_TIME_BUDGET_MS}},
  // Native adapter --json with rayon, same ranges: river 1000 in 0.5s; turn 200 in 1.3s at 0.008%; flop 60 in 14s at 0.04%.
  // 2026-10-14, 12 threads, BTN vs BB SRP ranges, end-to-end adapter wall time: turn 4.5s 270-340 iterations at 0.004%;
  // river 1000 iterations in 1.2s at <=0.002%. 100% vs 100% ranges: turn 4.5s 194-240 iterations at <=0.016% (2s: <=0.08%),
  // river 1.7s. Both streets answer well inside the 10 s requirement at this budget.
  native:NATIVE_BUDGETS,
  // River: 2026-10-16, 12 threads, BB/CO/BTN SRP ranges, 4.5s: 261-344 iterations, max best-response gain <=0.019% of
  // the pot; 100% ranges x3 at 2s: 118-139 iterations at <=0.075%. Turn (river checked down, an approximation):
  // 2026-10-19, same ranges, 4.5s: 18 iterations at 1.1-1.4%; 8s: 34-35 at 0.34-0.46%. The flop entry is unused.
  multiway:{...NATIVE_BUDGETS,turn:{iterations:500,accuracy:0.5,timeBudgetMs:MULTIWAY_TURN_BUDGET_MS}},
};

const BASE_SIZES:StreetSizes={betPercent:[50],raisePercent:[60]};
/**
 * Native adapter trees, 2026-11-26, 12 threads, SRP BB vs BTN and wide vs wide ranges (docs/SOLVER_INTEGRATION.md):
 * river 33/75/150% bets with a 60% raise reach <= 0.006% in 2 s; a turn with river betting (50%/60% on both streets)
 * reaches 0.29-0.48% in 4.5 s, while two turn sizes or three river sizes there stay above 1.6%. The flop library and
 * the browser solver keep the single-size tree with later streets checked down.
 */
const NATIVE_RIVER_SIZES:StreetSizes={betPercent:[33,75,150],raisePercent:[60]};
const NATIVE_LATER_STREETS:Partial<Record<SolverStreet,LaterStreetSizes>>={turn:{river:BASE_SIZES}};
/**
 * Native rivers offer all-in at any depth: 2026-11-26, SRP ranges, 33/75/150 tree, 2 s: 447 iterations at 0.11%.
 * On a turn (with river betting) it fell to 42 iterations at 6.4% in 4.5 s, so turns keep the SPR <= 1 rule.
 */
const NATIVE_ALL_IN_ALWAYS:SolverStreet[]=["river"];

function streetSizes(backend:SolverBackend,street:SolverStreet):StreetSizes{
  return backend==="native"&&street==="river"?NATIVE_RIVER_SIZES:BASE_SIZES;
}

/** Whether a heads-up DCFR solve of this street leaves every later street without betting. */
export function laterStreetsCheckedDown(backend:SolverBackend,street:SolverStreet){
  return street!=="river"&&!getSolverPreset(backend,street).laterStreets?.river;
}

/** True when the decision faces a bet or raise on this street (the last action this street was aggressive). */
export function facesAggression(streetActions:readonly {type:string}[]){
  const last=streetActions.at(-1)?.type;
  return last==="bet"||last==="raise";
}

/**
 * Where the decision sits on the street. Facing a bet or raise, native turns and rivers get NATIVE_FACING_BUDGET_MS:
 * an off-tree bet joins the street's size list and a raise adds a raise level, so the same 4.5 s buys about half
 * the iterations of a first-to-act node.
 */
export interface SolverNode { facingAggression?:boolean; }

export function getSolverPreset(backend:SolverBackend,street:SolverStreet,node:SolverNode={}):SolverPreset{
  const base=budgets[backend][street];
  const budget=backend==="native"&&street!=="flop"&&node.facingAggression?{...base,timeBudgetMs:NATIVE_FACING_BUDGET_MS}:base;
  const sizes=streetSizes(backend,street);
  const laterStreets=backend==="native"?NATIVE_LATER_STREETS[street]:undefined;
  return {
    ...budget,
    threads:MAX_THREADS,
    tree:{betPercent:[...sizes.betPercent],raisePercent:[...sizes.raisePercent],includeAllIn:false},
    ...(laterStreets?{laterStreets}:{}),
    ...(backend==="native"&&NATIVE_ALL_IN_ALWAYS.includes(street)?{allInPotRatio:0}:{}),
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
