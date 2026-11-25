import type { SolverStreet } from "../solver-presets";

/**
 * Nanoseconds per work unit (action slot x live combo) per iteration for the single-threaded wasm solver, measured
 * on the development PC (river ~100, turn ~270-290, flop ~290-330 including tree building), rounded up.
 */
export const DEFAULT_ITERATION_COST_NS:Record<SolverStreet,number>={river:110,turn:300,flop:340};

const STORAGE_KEY="rangelab.wasmIterationCostNs";
/** Weight of the newest sample; recent solves reflect the current machine load. */
const SAMPLE_WEIGHT=0.4;

type CostStorage={getItem(key:string):string|null;setItem(key:string,value:string):void};
export interface CostSample { elapsedMs:number;workUnits:number;iterations:number; }

const STREETS:SolverStreet[]=["flop","turn","river"];
/** Stored or measured costs outside this factor of the default are treated as corrupt or tampered with. */
const PLAUSIBLE_FACTOR=20;

const usable=(street:SolverStreet,value:unknown):value is number=>typeof value==="number"&&Number.isFinite(value)
  &&value>=DEFAULT_ITERATION_COST_NS[street]/PLAUSIBLE_FACTOR&&value<=DEFAULT_ITERATION_COST_NS[street]*PLAUSIBLE_FACTOR;

function readAll(storage:CostStorage|undefined):Partial<Record<SolverStreet,number>>{
  try{
    const parsed:unknown=JSON.parse(storage?.getItem(STORAGE_KEY)??"{}");
    if(!parsed||typeof parsed!=="object")return {};
    const values=parsed as Record<string,unknown>;
    return Object.fromEntries(STREETS.flatMap(street=>usable(street,values[street])?[[street,values[street]]]:[]));
  }catch{return {};}
}

/** The current per-unit cost for a street; storage is a per-viewer convenience, so failures fall back to defaults. */
export function loadIterationCost(storage:CostStorage|undefined,street:SolverStreet){
  return readAll(storage)[street]??DEFAULT_ITERATION_COST_NS[street];
}

/** Blends a finished solve's measured cost into the stored estimate and returns the new value. */
export function recordIterationCost(storage:CostStorage|undefined,street:SolverStreet,sample:CostSample){
  const previous=loadIterationCost(storage,street);
  const measured=sample.elapsedMs*1e6/(sample.workUnits*sample.iterations);
  if(!usable(street,measured))return previous;
  const next=previous*(1-SAMPLE_WEIGHT)+measured*SAMPLE_WEIGHT;
  try{storage?.setItem(STORAGE_KEY,JSON.stringify({...readAll(storage),[street]:next}));}catch{}
  return next;
}

export const expectedSolveMs=(costNs:number,workUnits:number,iterations:number)=>costNs*workUnits*iterations/1e6;
