import { availableParallelism } from "node:os";
import { NextResponse } from "next/server";
import type { TexasSolverJob } from "@/lib/texas-solver-config";
import { runTexasSolverDetailed } from "@/lib/server/run-texas-solver";
import { runCounterfactualBackend } from "@/lib/server/run-counterfactual-backend";
import { runDcfrAdapter } from "@/lib/server/run-dcfr-adapter";
import { resolveSolverThreads } from "@/lib/solver-presets";
import { clampSolverBudget, isTrustedSolverRequest, tryAcquireSolverSlot } from "@/lib/solver-guard";

export const runtime="nodejs";
export async function GET(){
  const remoteConfigured=Boolean(process.env.COUNTERFACTUAL_EV_BACKEND_URL);
  const dcfrConfigured=Boolean(process.env.DCFR_ADAPTER_PATH);
  const configuredMaximum=Number(process.env.COUNTERFACTUAL_EV_BACKEND_MAX_PLAYERS??8);
  const maxPlayers=remoteConfigured?Math.min(8,Math.max(2,Number.isInteger(configuredMaximum)?configuredMaximum:8)):2;
  return NextResponse.json({backend:remoteConfigured?"counterfactual":dcfrConfigured?"dcfr":"texassolver",maxPlayers:dcfrConfigured&&!remoteConfigured?2:maxPlayers},{headers:{"cache-control":"no-store"}});
}
export async function POST(request:Request){
  const remoteConfigured=Boolean(process.env.COUNTERFACTUAL_EV_BACKEND_URL);
  if(!remoteConfigured&&process.env.NODE_ENV==="production"&&!process.env.ALLOW_LOCAL_SOLVER_API)return NextResponse.json({error:"Local solver API is disabled in production."},{status:403});
  if(!isTrustedSolverRequest(request.headers))return NextResponse.json({error:"Solver API accepts same-origin JSON requests only."},{status:403});
  try{
    const requested=await request.json() as TexasSolverJob;
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
