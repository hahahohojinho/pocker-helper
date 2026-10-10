const DEFAULT_MAX_ITERATIONS=1000;
const MIN_ACCURACY=0.1;
const DEFAULT_MAX_CONCURRENCY=1;

const positiveInteger=(value:string|undefined)=>{const parsed=Number(value);return Number.isInteger(parsed)&&parsed>0?parsed:undefined;};

/** Bounds a client-supplied solve budget so one request cannot hold the CPU until the timeout. */
export function clampSolverBudget(budget:{iterations:number;accuracy:number},configuredMaxIterations:string|undefined){
  const maxIterations=positiveInteger(configuredMaxIterations)??DEFAULT_MAX_ITERATIONS;
  return {iterations:Math.min(budget.iterations,maxIterations),accuracy:Math.max(budget.accuracy,MIN_ACCURACY)};
}

// Kept on globalThis so dev-mode module re-evaluation cannot reset the count while solves are running.
const slotState=globalThis as typeof globalThis&{__rangelabActiveSolves?:number};

/** Returns an idempotent release callback, or null when every local solver slot is busy. */
export function tryAcquireSolverSlot(configuredMaxConcurrency:string|undefined):(()=>void)|null{
  const limit=positiveInteger(configuredMaxConcurrency)??DEFAULT_MAX_CONCURRENCY;
  if((slotState.__rangelabActiveSolves??0)>=limit)return null;
  slotState.__rangelabActiveSolves=(slotState.__rangelabActiveSolves??0)+1;
  let released=false;
  return ()=>{if(released)return;released=true;slotState.__rangelabActiveSolves=Math.max(0,(slotState.__rangelabActiveSolves??1)-1);};
}

/**
 * Rejects requests a third-party page could send to a locally running server: such pages can POST text/plain
 * without a CORS preflight, so the API requires a JSON content type and a same-origin fetch.
 */
export function isTrustedSolverRequest(headers:Headers){
  const contentType=headers.get("content-type")??"";
  if(contentType.split(";")[0].trim().toLowerCase()!=="application/json")return false;
  const fetchSite=headers.get("sec-fetch-site");
  if(fetchSite!==null&&fetchSite!=="same-origin")return false;
  const origin=headers.get("origin");
  if(origin===null)return true;
  try{return new URL(origin).host===headers.get("host");}catch{return false;}
}
