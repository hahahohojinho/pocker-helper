import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { buildTexasSolverCommands, TexasSolverJob } from "../texas-solver-config";
import { parseTexasSolverLog, resolveSolverTimeoutMs, type SolverLogSummary } from "../solver-presets";

const MAX_OUTPUT_BYTES=512*1024*1024;
const MAX_LOG_CHARS=64*1024;
const LOG_FILE="tmp_log.txt";
const MAX_STDERR_CHARS=4000;

export interface TexasSolverRun { output:string;convergence:SolverLogSummary; }

async function readSolverLog(workDir:string,stdout:string){
  try{
    const log=await readFile(join(workDir,LOG_FILE),"utf8");
    const summary=parseTexasSolverLog(log.slice(-MAX_LOG_CHARS));
    if(summary.exploitability!==undefined)return summary;
  }catch(error){
    if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;
  }
  return parseTexasSolverLog(stdout);
}

export async function runTexasSolverDetailed(job:TexasSolverJob,timeoutMs=resolveSolverTimeoutMs(process.env.SOLVER_TIMEOUT_MS),signal?:AbortSignal):Promise<TexasSolverRun>{
  const configured=process.env.TEXAS_SOLVER_PATH;
  if(!configured)throw new Error("TEXAS_SOLVER_PATH가 설정되지 않았습니다.");
  const executable=resolve(configured);
  if(basename(executable).toLowerCase()!=="console_solver.exe")throw new Error("console_solver.exe 경로만 허용합니다.");
  const workDir=await mkdtemp(join(tmpdir(),"rangelab-solver-"));
  const inputPath=join(workDir,"input.txt");const outputPath=join(workDir,"output_result.json");
  await writeFile(inputPath,buildTexasSolverCommands(job,"output_result.json"),"utf8");
  try{
    const stdout=await new Promise<string>((resolveRun,reject)=>{
      const child=spawn(executable,["-i",inputPath],{cwd:workDir,windowsHide:true,stdio:["ignore","pipe","pipe"]});
      let stderr="";child.stderr.on("data",chunk=>{stderr=(stderr+String(chunk)).slice(0,MAX_STDERR_CHARS)});
      let output="";child.stdout.on("data",chunk=>{output=(output+String(chunk)).slice(-MAX_LOG_CHARS)});
      let failure:Error|undefined;
      const stop=(error:Error)=>{failure??=error;child.kill();};
      const timer=setTimeout(()=>stop(new Error(`Solver timeout after ${timeoutMs}ms. SOLVER_TIMEOUT_MS를 늘리거나 레인지를 줄이세요.`)),timeoutMs);
      const onAbort=()=>stop(new Error("Solver request was cancelled."));
      if(signal?.aborted)onAbort();else signal?.addEventListener("abort",onAbort,{once:true});
      const settle=()=>{clearTimeout(timer);signal?.removeEventListener("abort",onAbort);};
      child.once("error",error=>{settle();reject(failure??error)});
      // Waiting for exit before rejecting lets Windows release file locks before the job directory is removed.
      child.once("exit",code=>{settle();if(failure)reject(failure);else if(code===0)resolveRun(output);else reject(new Error(`Solver exited with ${code}: ${stderr}`));});
    });
    const outputStat=await stat(outputPath);
    if(outputStat.size>MAX_OUTPUT_BYTES)throw new Error("Solver output exceeds 512MB limit.");
    const result=await readFile(outputPath);
    return {output:result.toString("utf8"),convergence:await readSolverLog(workDir,stdout)};
  }finally{
    await rm(workDir,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(error=>console.error(`Failed to remove solver job directory ${workDir}`,error));
  }
}

export async function runTexasSolver(job:TexasSolverJob,timeoutMs?:number){
  return (await runTexasSolverDetailed(job,timeoutMs)).output;
}
