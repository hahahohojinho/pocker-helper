import { NextResponse } from "next/server";
import type { TexasSolverJob } from "@/lib/texas-solver-config";
import { runTexasSolver } from "@/lib/server/run-texas-solver";
import { runCounterfactualBackend } from "@/lib/server/run-counterfactual-backend";

export const runtime="nodejs";
export async function POST(request:Request){
  const remoteConfigured=Boolean(process.env.COUNTERFACTUAL_EV_BACKEND_URL);
  if(!remoteConfigured&&process.env.NODE_ENV==="production"&&!process.env.ALLOW_LOCAL_SOLVER_API)return NextResponse.json({error:"Local solver API is disabled in production."},{status:403});
  try{
    const job=await request.json() as TexasSolverJob;
    const output=remoteConfigured?await runCounterfactualBackend(job):await runTexasSolver(job);
    return new NextResponse(output,{headers:{"content-type":"application/json","cache-control":"no-store"}});
  }catch(error){return NextResponse.json({error:error instanceof Error?error.message:"Solver execution failed."},{status:400});}
}
