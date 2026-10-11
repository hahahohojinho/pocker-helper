import type { WasmSolveRequest } from "./request";

/** The server cannot run the native solver (not configured, disabled, or unreachable); callers fall back to wasm. */
export class NativeSolverUnavailableError extends Error {}

const errorMessage=(raw:string,fallback:string)=>{try{return (JSON.parse(raw) as {error?:string}).error??fallback;}catch{return fallback;}};

/** Posts the in-browser solver's request to /api/solver for the native multi-threaded adapter. */
export async function runNativeSolve(request:WasmSolveRequest,options:{signal?:AbortSignal;fetchImpl?:typeof fetch}={}){
  let response:Response;
  try{
    response=await (options.fetchImpl??fetch)("/api/solver",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({kind:"dcfr-json",request}),signal:options.signal,cache:"no-store"});
  }catch(error){
    if(options.signal?.aborted)throw new Error("Native solve was cancelled.");
    throw new NativeSolverUnavailableError(error instanceof Error?error.message:"Native solver is unreachable.");
  }
  const raw=await response.text();
  if(response.status===403||response.status===404)throw new NativeSolverUnavailableError(errorMessage(raw,"Native solver is not enabled."));
  if(!response.ok)throw new Error(errorMessage(raw,`Native solver failed (HTTP ${response.status}).`));
  return raw;
}
