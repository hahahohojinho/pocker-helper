// Builds tools/dcfr-wasm for wasm32 and publishes the module, its checksum, and license notices under public/solver.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const TARGET="wasm32-unknown-unknown";
const root=resolve(import.meta.dirname,"..");
const crate=join(root,"tools","dcfr-wasm");
const installedCargo=join(homedir(),".cargo","bin",process.platform==="win32"?"cargo.exe":"cargo");
const cargo=process.env.CARGO??(existsSync(installedCargo)?installedCargo:"cargo");
const output=join(root,"public","solver");
const wasmName="rangelab_dcfr_wasm.wasm";
const LICENSE_FILE=/^(licen[cs]e|copying|notice)/i;

/** Crates linked into the wasm: normal (non-build, non-dev) dependencies reachable from the root, minus proc-macros. */
function linkedPackages(){
  const metadata=JSON.parse(execFileSync(cargo,["metadata","--format-version","1","--locked","--filter-platform",TARGET],{cwd:crate,encoding:"utf8",maxBuffer:64*1024*1024}));
  const packages=new Map(metadata.packages.map(item=>[item.id,item]));
  const nodes=new Map(metadata.resolve.nodes.map(node=>[node.id,node]));
  const isProcMacro=item=>item.targets.every(target=>target.kind.includes("proc-macro"));
  const seen=new Set();const queue=[metadata.resolve.root];
  while(queue.length){
    const id=queue.pop();if(seen.has(id))continue;seen.add(id);
    // Proc-macros and their dependencies run in the compiler and are not linked into the wasm.
    if(isProcMacro(packages.get(id)))continue;
    for(const dep of nodes.get(id)?.deps??[])if(dep.dep_kinds.some(kind=>kind.kind===null))queue.push(dep.pkg);
  }
  seen.delete(metadata.resolve.root);
  return [...seen].map(id=>packages.get(id)).filter(item=>!isProcMacro(item)).sort((a,b)=>a.name.localeCompare(b.name));
}

function thirdPartyNotice(){
  const sections=linkedPackages().map(item=>{
    const directory=dirname(item.manifest_path);
    const isShim=item.source===null&&directory.startsWith(join(crate,"shims"));
    if(isShim)return `${item.name} ${item.version} (RangeLab shim in tools/dcfr-wasm/shims, not the upstream crate)\n`;
    const texts=readdirSync(directory).filter(name=>LICENSE_FILE.test(name)).sort().map(name=>`--- ${name} ---\n${readFileSync(join(directory,name),"utf8").trim()}\n`);
    if(!texts.length)throw new Error(`${item.name} ${item.version} ships no license file; add its notice manually.`);
    return `${item.name} ${item.version} - ${item.license??"see files"}\n${item.repository??""}\n${texts.join("\n")}`;
  });
  const header="Third-party software included in rangelab_dcfr_wasm.wasm.\nThe Rust standard library is also linked: MIT OR Apache-2.0, Copyright (c) The Rust Project Contributors (https://github.com/rust-lang/rust).\n";
  return `${header}\n${sections.join(`\n${"=".repeat(72)}\n\n`)}`;
}

execFileSync(cargo,["build","--release","--locked","--lib","--target",TARGET],{cwd:crate,stdio:"inherit"});
mkdirSync(output,{recursive:true});
const wasmPath=join(output,wasmName);
copyFileSync(join(crate,"target",TARGET,"release",wasmName),wasmPath);
writeFileSync(`${wasmPath}.sha256`,`${createHash("sha256").update(readFileSync(wasmPath)).digest("hex")}  ${wasmName}\n`);
copyFileSync(join(root,"tools","dcfr-solver","LICENSE"),join(output,"LICENSE-dcfr-solver.txt"));
writeFileSync(join(output,"THIRD-PARTY-LICENSES.txt"),thirdPartyNotice());
console.log(`Published ${wasmPath}`);
