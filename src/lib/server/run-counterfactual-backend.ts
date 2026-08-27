import { validateTexasSolverJob, type TexasSolverJob } from "../texas-solver-config";
import { parseSolverResult } from "../solver-adapter";

const MAX_RESPONSE_BYTES=4*1024*1024;

export async function runCounterfactualBackend(job:TexasSolverJob,timeoutMs=120_000){
  validateTexasSolverJob(job);
  const configured=process.env.COUNTERFACTUAL_EV_BACKEND_URL;
  if(!configured)throw new Error("COUNTERFACTUAL_EV_BACKEND_URL이 설정되지 않았습니다.");
  let url:URL;
  try{url=new URL(configured);}catch{throw new Error("COUNTERFACTUAL_EV_BACKEND_URL이 올바른 URL이 아닙니다.");}
  if(!["http:","https:"].includes(url.protocol))throw new Error("Counterfactual EV backend는 HTTP(S) URL이어야 합니다.");
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const headers:Record<string,string>={"content-type":"application/json","accept":"application/json"};
    if(process.env.COUNTERFACTUAL_EV_BACKEND_TOKEN)headers.authorization=`Bearer ${process.env.COUNTERFACTUAL_EV_BACKEND_TOKEN}`;
    const response=await fetch(url,{method:"POST",headers,body:JSON.stringify(job),signal:controller.signal,cache:"no-store"});
    if(!response.ok)throw new Error(`Counterfactual EV backend returned HTTP ${response.status}.`);
    const declaredLength=Number(response.headers.get("content-length")??0);
    if(declaredLength>MAX_RESPONSE_BYTES)throw new Error("Counterfactual EV backend response exceeds 4 MB limit.");
    const raw=await response.text();
    if(new TextEncoder().encode(raw).byteLength>MAX_RESPONSE_BYTES)throw new Error("Counterfactual EV backend response exceeds 4 MB limit.");
    const parsed=parseSolverResult(raw);
    if(parsed.evSource!=="solver")throw new Error("Counterfactual EV backend response must include EV for every action.");
    const candidates=new Set(job.node.candidateActions);
    if(parsed.actions.some(action=>!candidates.has(action.action)))throw new Error("Counterfactual EV backend returned an action outside candidateActions.");
    if(parsed.actions.some(action=>!Number.isFinite(action.frequency)||action.frequency<0||!Number.isFinite(action.ev)))throw new Error("Counterfactual EV backend returned invalid frequency or EV values.");
    return raw;
  }catch(error){
    if(error instanceof Error&&error.name==="AbortError")throw new Error(`Counterfactual EV backend timeout after ${timeoutMs}ms`);
    throw error;
  }finally{clearTimeout(timer);}
}
