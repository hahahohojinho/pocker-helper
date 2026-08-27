import { NextResponse } from "next/server";
import type { TexasSolverJob } from "@/lib/texas-solver-config";
import { runTexasSolver } from "@/lib/server/run-texas-solver";
import { runCounterfactualBackend } from "@/lib/server/run-counterfactual-backend";

export const runtime="nodejs";
export async function GET(){
  const remoteConfigured=Boolean(process.env.COUNTERFACTUAL_EV_BACKEND_URL);
  const configuredMaximum=Number(process.env.COUNTERFACTUAL_EV_BACKEND_MAX_PLAYERS??8);
  const maxPlayers=remoteConfigured?Math.min(8,Math.max(2,Number.isInteger(configuredMaximum)?configuredMaximum:8)):2;
  return NextResponse.json({backend:remoteConfigured?"counterfactual":"texassolver",maxPlayers},{headers:{"cache-control":"no-store"}});
}
export async function POST(request:Request){
  const remoteConfigured=Boolean(process.env.COUNTERFACTUAL_EV_BACKEND_URL);
  if(!remoteConfigured&&process.env.NODE_ENV==="production"&&!process.env.ALLOW_LOCAL_SOLVER_API)return NextResponse.json({error:"Local solver API is disabled in production."},{status:403});
  try{
    const job=await request.json() as TexasSolverJob;
    if(!remoteConfigured&&job.players&&job.players.length>2)return NextResponse.json({error:"Local TexasSolver supports heads-up jobs only."},{status:400});
    const output=remoteConfigured?await runCounterfactualBackend(job):await runTexasSolver(job);
    return new NextResponse(output,{headers:{"content-type":"application/json","cache-control":"no-store"}});
  }catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Solver execution failed."},{status:400});}
}
