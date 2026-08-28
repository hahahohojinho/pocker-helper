import { spawn } from "node:child_process";
import { basename, resolve } from "node:path";
import { parseSolverResult } from "../solver-adapter";
import { validateTexasSolverJob, type TexasSolverJob } from "../texas-solver-config";

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

export async function runDcfrAdapter(job:TexasSolverJob,timeoutMs=120_000){
  const configured=process.env.DCFR_ADAPTER_PATH;
  if(!configured)throw new Error("DCFR_ADAPTER_PATH is not configured.");
  const executable=resolve(configured);
  if(basename(executable).toLowerCase()!=="rangelab-dcfr-adapter.exe")throw new Error("DCFR_ADAPTER_PATH must point to rangelab-dcfr-adapter.exe.");
  const args=buildDcfrAdapterArgs(job);
  const raw=await new Promise<string>((resolveRun,reject)=>{
    const child=spawn(executable,args,{windowsHide:true,stdio:["ignore","pipe","pipe"]});
    const output:Buffer[]=[];const errors:Buffer[]=[];let bytes=0;let settled=false;
    const finish=(error?:Error,value?:string)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolveRun(value??"");};
    const timer=setTimeout(()=>{child.kill();finish(new Error(`DCFR adapter timeout after ${timeoutMs}ms`));},timeoutMs);
    child.stdout.on("data",(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>MAX_OUTPUT_BYTES){child.kill();finish(new Error("DCFR adapter output exceeds 4 MB limit."));return;}output.push(chunk);});
    child.stderr.on("data",(chunk:Buffer)=>{if(Buffer.concat(errors).length<16_384)errors.push(chunk);});
    child.once("error",error=>finish(error));
    child.once("exit",code=>code===0?finish(undefined,Buffer.concat(output).toString("utf8")):finish(new Error(`DCFR adapter exited with ${code}: ${Buffer.concat(errors).toString("utf8").slice(0,16_384)}`)));
  });
  const parsed=parseSolverResult(raw);
  if(parsed.evSource!=="solver")throw new Error("DCFR adapter response must include EV for every action.");
  const candidates=new Set(job.node.candidateActions);
  if(parsed.actions.some(action=>!candidates.has(action.action)))throw new Error("DCFR adapter returned an action outside candidateActions.");
  return raw;
}
