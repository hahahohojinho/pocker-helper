import { availableParallelism } from "node:os";
import { NextResponse } from "next/server";
import type { TexasSolverJob } from "@/lib/texas-solver-config";
import { runTexasSolverDetailed } from "@/lib/server/run-texas-solver";
import { runCounterfactualBackend } from "@/lib/server/run-counterfactual-backend";
import { runDcfrAdapter, runDcfrJsonAdapter } from "@/lib/server/run-dcfr-adapter";
import { resolveSolverThreads, resolveSolverTimeoutMs } from "@/lib/solver-presets";
import { clampSolverBudget, isTrustedSolverRequest, nativeJsonSolverEnabled, nativeTimeBudget, parseSolverBody, readSolverBody, SolverBodyTooLargeError, tryAcquireSolverSlot } from "@/lib/solver-guard";

/** The adapter is killed this long after its time budget if it has not exited. */
const ADAPTER_TIMEOUT_SLACK_MS=10_000;
import type { WasmSolveRequest } from "@/lib/wasm-solver/request";

export const runtime="nodejs";
export async function GET(){
  const remoteConfigured=Boolean(process.env.COUNTERFACTUAL_EV_BACKEND_URL);
  const dcfrConfigured=Boolean(process.env.DCFR_ADAPTER_PATH);
  const configuredMaximum=Number(process.env.COUNTERFACTUAL_EV_BACKEND_MAX_PLAYERS??8);
  const maxPlayers=remoteConfigured?Math.min(8,Math.max(2,Number.isInteger(configuredMaximum)?configuredMaximum:8)):2;
  return NextResponse.json({backend:remoteConfigured?"counterfactual":dcfrConfigured?"dcfr":"texassolver",maxPlayers:dcfrConfigured&&!remoteConfigured?2:maxPlayers,nativeJson:nativeJsonSolverEnabled(process.env)},{headers:{"cache-control":"no-store"}});
}
export async function POST(request:Request){
  const receivedAt=Date.now();
  const remoteConfigured=Boolean(process.env.COUNTERFACTUAL_EV_BACKEND_URL);
  if(!remoteConfigured&&process.env.NODE_ENV==="production"&&!process.env.ALLOW_LOCAL_SOLVER_API)return NextResponse.json({error:"Local solver API is disabled in production."},{status:403});
  if(!isTrustedSolverRequest(request.headers))return NextResponse.json({error:"Solver API accepts same-origin JSON requests only."},{status:403});
  let body:ReturnType<typeof parseSolverBody>;
  try{body=parseSolverBody(await readSolverBody(request));}
  catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Invalid solver request."},{status:error instanceof SolverBodyTooLargeError?413:400});}
  if(body.kind==="dcfr-json")return solveNativeJson(body.request,request.signal,receivedAt);
  try{
    const requested=body.job as unknown as TexasSolverJob;
    const dcfrConfigured=Boolean(process.env.DCFR_ADAPTER_PATH);
    if(!remoteConfigured&&requested.players&&requested.players.length>2)return NextResponse.json({error:"Local solver supports heads-up jobs only."},{status:400});
    const headers:Record<string,string>={"content-type":"application/json","cache-control":"no-store"};
    if(remoteConfigured)return new NextResponse(await runCounterfactualBackend(requested),{headers});
    const release=tryAcquireSolverSlot(process.env.SOLVER_MAX_CONCURRENCY);
    if(!release)return NextResponse.json({error:"다른 Solver 작업이 실행 중입니다. 완료 후 다시 시도하세요."},{status:429});
    try{
      const job={...requested,...clampSolverBudget(requested,process.env.SOLVER_MAX_ITERATIONS),threads:resolveSolverThreads(requested.threads,process.env.SOLVER_MAX_THREADS,availableParallelism())};
      if(dcfrConfigured)return new NextResponse(await runDcfrAdapter(job,undefined,request.signal),{headers});
      const {output,convergence}=await runTexasSolverDetailed(job,undefined,request.signal);
      if(convergence.exploitability!==undefined)headers["x-solver-exploitability"]=String(convergence.exploitability);
      return new NextResponse(output,{headers});
    }finally{release();}
  }catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Solver execution failed."},{status:400});}
}

/** Native multi-threaded solve of the in-browser solver's request format; dcfr-core validates the request itself. */
async function solveNativeJson(raw:Record<string,unknown>,signal:AbortSignal,receivedAt:number){
  if(!nativeJsonSolverEnabled(process.env))return NextResponse.json({error:"Native DCFR solver is not enabled."},{status:404});
  const release=tryAcquireSolverSlot(process.env.SOLVER_MAX_CONCURRENCY);
  if(!release)return NextResponse.json({error:"다른 Solver 작업이 실행 중입니다. 완료 후 다시 시도하세요."},{status:429});
  try{
    const {iterations}=clampSolverBudget({iterations:raw.iterations as number,accuracy:1},process.env.SOLVER_MAX_ITERATIONS);
    const threads=resolveSolverThreads(availableParallelism(),process.env.SOLVER_MAX_THREADS,availableParallelism());
    const timeBudgetMs=nativeTimeBudget(raw.timeBudgetMs,process.env.SOLVER_MAX_BUDGET_MS,Date.now()-receivedAt);
    const timeoutMs=Math.min(resolveSolverTimeoutMs(process.env.SOLVER_TIMEOUT_MS),timeBudgetMs+ADAPTER_TIMEOUT_SLACK_MS);
    const output=await runDcfrJsonAdapter({...raw,iterations,timeBudgetMs} as unknown as WasmSolveRequest,{threads,signal,timeoutMs});
    return new NextResponse(output,{headers:{"content-type":"application/json","cache-control":"no-store"}});
  }catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Native solver failed."},{status:400});}
  finally{release();}
}
