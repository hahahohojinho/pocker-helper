import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { buildTexasSolverCommands, TexasSolverJob } from "../texas-solver-config";

const MAX_OUTPUT_BYTES=512*1024*1024;

export async function runTexasSolver(job:TexasSolverJob,timeoutMs=120_000){
  const configured=process.env.TEXAS_SOLVER_PATH;
  if(!configured)throw new Error("TEXAS_SOLVER_PATH가 설정되지 않았습니다.");
  const executable=resolve(configured);
  if(basename(executable).toLowerCase()!=="console_solver.exe")throw new Error("console_solver.exe 경로만 허용합니다.");
  const workDir=await mkdtemp(join(tmpdir(),"rangelab-solver-"));
  const inputPath=join(workDir,"input.txt");const outputPath=join(workDir,"output_result.json");
  await writeFile(inputPath,buildTexasSolverCommands(job,"output_result.json"),"utf8");
  try{
    await new Promise<void>((resolveRun,reject)=>{
      const child=spawn(executable,["-i",inputPath],{cwd:workDir,windowsHide:true,stdio:["ignore","pipe","pipe"]});
      let stderr="";child.stderr.on("data",chunk=>{stderr+=String(chunk).slice(0,4000)});
      const timer=setTimeout(()=>{child.kill();reject(new Error(`Solver timeout after ${timeoutMs}ms`));},timeoutMs);
      child.once("error",error=>{clearTimeout(timer);reject(error)});
      child.once("exit",code=>{clearTimeout(timer);if(code===0)resolveRun();else reject(new Error(`Solver exited with ${code}: ${stderr}`));});
    });
    const outputStat=await stat(outputPath);
    if(outputStat.size>MAX_OUTPUT_BYTES)throw new Error("Solver output exceeds 512MB limit.");
    const result=await readFile(outputPath);
    return result.toString("utf8");
  }finally{await rm(workDir,{recursive:true,force:true});}
}
