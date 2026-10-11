import { spawn } from "node:child_process";
import { basename, resolve } from "node:path";
import { parseSolverResult } from "../solver-adapter";
import { resolveSolverTimeoutMs } from "../solver-presets";
import { validateTexasSolverJob, type TexasSolverJob } from "../texas-solver-config";
import { wasmResponseToSolverJson, type WasmSolveRequest, type WasmSolveResponse } from "../wasm-solver/request";

const MAX_OUTPUT_BYTES=4*1024*1024;
const SCALE=100;

export function buildDcfrAdapterArgs(job:TexasSolverJob){
  validateTexasSolverJob(job);
  if(job.players&&job.players.length>2)throw new Error("Local DCFR adapter supports heads-up jobs only.");
  if(job.actionHistory?.length)throw new Error("Local DCFR adapter currently supports street root nodes only.");
  if(job.node.toCall!==0)throw new Error("Local DCFR adapter requires an OOP street root with nothing to call.");
  const integer=(value:number)=>String(Math.max(1,Math.round(value*SCALE)));
  return [
    "--board",job.node.board.join(""),
    "--hero",job.node.heroHole.join(""),
    "--oop-range",job.ranges.oop,
    "--ip-range",job.ranges.ip,
    "--pot",integer(job.node.pot),
    "--stack",integer(job.node.effectiveStack),
    "--iterations",String(job.iterations),
    "--bet-percent",String(Math.round(job.tree.betPercent[0])),
    "--raise-percent",String(Math.round(job.tree.raisePercent[0])),
  ];
}

function adapterExecutable(){
  const configured=process.env.DCFR_ADAPTER_PATH;
  if(!configured)throw new Error("DCFR_ADAPTER_PATH is not configured.");
  const executable=resolve(configured);
  if(basename(executable).toLowerCase()!=="rangelab-dcfr-adapter.exe")throw new Error("DCFR_ADAPTER_PATH must point to rangelab-dcfr-adapter.exe.");
  return executable;
}

/** Only what the adapter needs: the server's other variables (backend tokens and the like) stay out of the child. */
function adapterEnvironment(threads:number):Record<string,string>{
  const passthrough=["PATH","SystemRoot","SYSTEMROOT","TEMP","TMP","HOME","USERPROFILE"];
  return {...Object.fromEntries(passthrough.flatMap(name=>{const value=process.env[name];return value===undefined?[]:[[name,value]];})),RAYON_NUM_THREADS:String(threads)};
}

interface AdapterRun { args:string[];stdin?:string;timeoutMs:number;signal?:AbortSignal;env?:Record<string,string>; }

/** Runs the adapter with a timeout, abort support, a 4 MB stdout cap, and a bounded stderr excerpt. */
function runAdapterProcess(run:AdapterRun){
  return new Promise<string>((resolveRun,reject)=>{
    const child=spawn(adapterExecutable(),run.args,{windowsHide:true,stdio:["pipe","pipe","pipe"],env:run.env as NodeJS.ProcessEnv|undefined});
    const output:Buffer[]=[];const errors:Buffer[]=[];let bytes=0;let settled=false;
    const onAbort=()=>{child.kill();finish(new Error("DCFR adapter request was cancelled."));};
    const finish=(error?:Error,value?:string)=>{if(settled)return;settled=true;clearTimeout(timer);run.signal?.removeEventListener("abort",onAbort);if(error)reject(error);else resolveRun(value??"");};
    const timer=setTimeout(()=>{child.kill();finish(new Error(`DCFR adapter timeout after ${run.timeoutMs}ms`));},run.timeoutMs);
    if(run.signal?.aborted)onAbort();else run.signal?.addEventListener("abort",onAbort,{once:true});
    child.stdout.on("data",(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>MAX_OUTPUT_BYTES){child.kill();finish(new Error("DCFR adapter output exceeds 4 MB limit."));return;}output.push(chunk);});
    child.stderr.on("data",(chunk:Buffer)=>{if(Buffer.concat(errors).length<16_384)errors.push(chunk);});
    child.once("error",error=>finish(error));
    // "close" waits for stdio to drain; "exit" can fire before the last stdout chunk arrives.
    child.once("close",code=>code===0?finish(undefined,Buffer.concat(output).toString("utf8")):finish(new Error(`DCFR adapter exited with ${code}: ${Buffer.concat(errors).toString("utf8").slice(0,16_384)}`)));
    // The adapter stops reading oversized input and reports it in its envelope, so EPIPE here is expected.
    child.stdin.on("error",()=>{});
    child.stdin.end(run.stdin??"");
  });
}

export async function runDcfrAdapter(job:TexasSolverJob,timeoutMs=resolveSolverTimeoutMs(process.env.SOLVER_TIMEOUT_MS),signal?:AbortSignal){
  const raw=await runAdapterProcess({args:buildDcfrAdapterArgs(job),timeoutMs,signal});
  const parsed=parseSolverResult(raw);
  if(parsed.evSource!=="solver")throw new Error("DCFR adapter response must include EV for every action.");
  const candidates=new Set(job.node.candidateActions);
  if(parsed.actions.some(action=>!candidates.has(action.action)))throw new Error("DCFR adapter returned an action outside candidateActions.");
  return raw;
}

/**
 * Solves the in-browser solver's request format with the native, multi-threaded adapter (`--json`).
 * Returns normalized solver JSON, the same shape the wasm path produces.
 */
export async function runDcfrJsonAdapter(request:WasmSolveRequest,options:{threads:number;timeoutMs?:number;signal?:AbortSignal}){
  const raw=await runAdapterProcess({
    args:["--json"],stdin:JSON.stringify(request),signal:options.signal,
    timeoutMs:options.timeoutMs??resolveSolverTimeoutMs(process.env.SOLVER_TIMEOUT_MS),
    // rayon's global pool reads RAYON_NUM_THREADS when dcfr-solver builds it.
    env:adapterEnvironment(options.threads),
  });
  let envelope:WasmSolveResponse;
  try{envelope=JSON.parse(raw) as WasmSolveResponse;}catch{throw new Error("DCFR adapter returned invalid JSON.");}
  const normalized=wasmResponseToSolverJson(envelope);
  if(parseSolverResult(normalized).evSource!=="solver")throw new Error("DCFR adapter response must include EV for every action.");
  return normalized;
}
