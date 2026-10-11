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

/** Larger than the 256KB wasm request limit plus the job wrapper. */
export const MAX_SOLVER_BODY_BYTES=300*1024;

export class SolverBodyTooLargeError extends Error {}

export type SolverBody={kind:"dcfr-json";request:Record<string,unknown>}|{kind:"job";job:Record<string,unknown>};

/** Parses a POST body: `{kind:"dcfr-json",request}` for the native adapter, anything else as a legacy solver job. */
export function parseSolverBody(text:string):SolverBody{
  if(new TextEncoder().encode(text).byteLength>MAX_SOLVER_BODY_BYTES)throw new SolverBodyTooLargeError(`Solver request exceeds ${MAX_SOLVER_BODY_BYTES} bytes.`);
  let value:unknown;
  try{value=JSON.parse(text);}catch{throw new Error("Solver request is not valid JSON.");}
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Solver request must be a JSON object.");
  const body=value as Record<string,unknown>;
  if(body.kind!=="dcfr-json")return {kind:"job",job:body};
  const request=body.request;
  if(!request||typeof request!=="object"||Array.isArray(request)||!Number.isInteger((request as Record<string,unknown>).iterations))throw new Error("dcfr-json request needs an object with integer iterations.");
  return {kind:"dcfr-json",request:request as Record<string,unknown>};
}

/** Whether the native adapter accepts dcfr-json requests: configured, not shadowed by a remote backend, and allowed. */
export function nativeJsonSolverEnabled(env:Record<string,string|undefined>){
  return Boolean(env.DCFR_ADAPTER_PATH)&&!env.COUNTERFACTUAL_EV_BACKEND_URL&&(env.NODE_ENV!=="production"||Boolean(env.ALLOW_LOCAL_SOLVER_API));
}

/** Reads a request body, aborting as soon as it exceeds MAX_SOLVER_BODY_BYTES instead of buffering it whole. */
export async function readSolverBody(request:Request){
  const declared=Number(request.headers.get("content-length"));
  if(Number.isFinite(declared)&&declared>MAX_SOLVER_BODY_BYTES)throw new SolverBodyTooLargeError(`Solver request exceeds ${MAX_SOLVER_BODY_BYTES} bytes.`);
  if(!request.body)return "";
  const reader=request.body.getReader();const chunks:Uint8Array[]=[];let size=0;
  for(;;){
    const {done,value}=await reader.read();
    if(done)break;
    size+=value.byteLength;
    if(size>MAX_SOLVER_BODY_BYTES){await reader.cancel();throw new SolverBodyTooLargeError(`Solver request exceeds ${MAX_SOLVER_BODY_BYTES} bytes.`);}
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

const DEFAULT_MAX_BUDGET_MS=10_000;
/** dcfr-core rejects budgets below this. */
const MIN_NATIVE_BUDGET_MS=200;
/** Process start, stdin, and JSON output around the solve. */
const ADAPTER_OVERHEAD_MS=150;

/**
 * Time budget passed to the native adapter: the client's request (or the maximum when it sent none) capped by
 * SOLVER_MAX_BUDGET_MS, minus the time already spent in the route and the adapter's own overhead. Always defined, so
 * omitting the field cannot escape the server's cap.
 */
export function nativeTimeBudget(requested:unknown,configuredMax:string|undefined,elapsedMs:number){
  const maximum=positiveInteger(configuredMax)??DEFAULT_MAX_BUDGET_MS;
  const wanted=typeof requested==="number"&&Number.isFinite(requested)?requested:maximum;
  return Math.max(MIN_NATIVE_BUDGET_MS,Math.round(Math.min(wanted,maximum)-elapsedMs-ADAPTER_OVERHEAD_MS));
}
