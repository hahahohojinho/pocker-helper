// Trains and exports preflop packs for a matrix of table sizes and stack depths, resuming from checkpoints.
//
//   node scripts/run-preflop-matrix.mjs "6:20,6:40,6:60,6:100,6:150@5;8:20,8:40,8:60,8:100,8:150@2"
//
// Groups (separated by ";") run one after another; "@N" is how many jobs of that group run at once. Each job writes
// a checkpoint to artifacts/preflop/<n>max-<stack>bb.bin, logs to artifacts/preflop/logs, and on completion exports
// public/data/preflop/<n>max-<stack>bb.json. Re-running the same command resumes unfinished jobs.
import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root=resolve(import.meta.dirname,"..");
const binary=join(root,"tools","rangelab-preflop","target","release",process.platform==="win32"?"rangelab-preflop.exe":"rangelab-preflop");
const workDir=join(root,"artifacts","preflop");
const logDir=join(workDir,"logs");
const packDir=join(root,"public","data","preflop");
/** 6-max matches the upstream 100M reference; 8-max has ~4x the information sets, so it trains twice as long. */
const ITERATIONS={6:100_000_000,8:200_000_000};
const CHECKPOINT_EVERY=5_000_000;
const SEED=42;
const MAX_CONCURRENCY=8;

function parseGroups(text){
  return text.split(";").filter(Boolean).map(group=>{
    const [list,concurrency="1"]=group.split("@");
    const jobs=list.split(",").filter(Boolean).map(item=>{
      const [players,stack]=item.split(":").map(Number);
      if(![6,8].includes(players)||!Number.isInteger(stack)||stack<10||stack>300)throw new Error(`Invalid job "${item}"; use players:stack such as 6:100.`);
      return {players,stack,name:`${players}max-${stack}bb`};
    });
    // Each job is single-threaded but 8-max blueprints need several GB, so concurrency is capped.
    return {jobs,concurrency:Math.min(MAX_CONCURRENCY,Math.max(1,Number(concurrency)||1))};
  });
}

function run(args,logStream){
  return new Promise((resolveRun,reject)=>{
    const child=spawn(binary,args,{cwd:root,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    child.stdout.pipe(logStream,{end:false});
    child.stderr.pipe(logStream,{end:false});
    child.once("error",reject);
    child.once("close",code=>code===0?resolveRun():reject(new Error(`${args[0]} exited with ${code}`)));
  });
}

async function runJob(job,revision){
  const blueprint=join(workDir,`${job.name}.bin`);
  const pack=join(packDir,`${job.name}.json`);
  const log=createWriteStream(join(logDir,`${job.name}.log`),{flags:"a"});
  const stamp=()=>new Date().toISOString();
  try{
    log.write(`\n[${stamp()}] start ${job.name}\n`);
    await run(["train","--players",String(job.players),"--stack",String(job.stack),"--iterations",String(ITERATIONS[job.players]),"--seed",String(SEED),"--checkpoint-every",String(CHECKPOINT_EVERY),"--out",blueprint,"--resume"],log);
    await run(["export","--blueprint",blueprint,"--out",pack,"--id",`dcfr-${job.name}-v1`,"--revision",revision,"--generated-at",stamp().slice(0,10)],log);
    log.write(`[${stamp()}] done ${job.name}: ${(statSync(pack).size/1024).toFixed(0)} KB pack\n`);
    console.log(`done ${job.name}`);
  }catch(error){
    log.write(`[${stamp()}] failed ${job.name}: ${error.message}\n`);
    console.error(`failed ${job.name}: ${error.message}`);
    process.exitCode=1;
  }finally{log.end();}
}

async function runGroup({jobs,concurrency},revision){
  const queue=[...jobs];
  const workers=Array.from({length:Math.min(concurrency,queue.length)},async()=>{
    for(let job=queue.shift();job;job=queue.shift())await runJob(job,revision);
  });
  await Promise.all(workers);
}

const groups=parseGroups(process.argv[2]??"");
if(!groups.length)throw new Error('Pass job groups, e.g. "6:100@1".');
// Two workers on the same job would write the same checkpoint.
const names=groups.flatMap(group=>group.jobs.map(job=>job.name));
if(new Set(names).size!==names.length)throw new Error("Each players:stack job may appear only once.");
if(!existsSync(binary))throw new Error(`Build the solver first: cargo build --release in tools/rangelab-preflop (${binary} not found).`);
for(const directory of [workDir,logDir,packDir])mkdirSync(directory,{recursive:true});
const solverDir=join(root,"tools","dcfr-solver");
// An uninitialized submodule would make git report the parent repository's HEAD instead.
const toplevel=execFileSync("git",["-C",solverDir,"rev-parse","--show-toplevel"],{encoding:"utf8"}).trim();
if(resolve(toplevel)!==resolve(solverDir))throw new Error("tools/dcfr-solver is not an initialized submodule; run git submodule update --init.");
const revision=execFileSync("git",["-C",solverDir,"rev-parse","HEAD"],{encoding:"utf8"}).trim();
for(const group of groups)await runGroup(group,revision);
console.log("matrix finished");
