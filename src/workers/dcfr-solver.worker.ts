/// <reference lib="webworker" />
import { WasmSolverEngine } from "../lib/wasm-solver/engine";
import type { WasmWorkerRequest, WasmWorkerResponse } from "../lib/wasm-solver/client";

let engine:Promise<WasmSolverEngine>|null=null;

self.onmessage=async(event:MessageEvent<WasmWorkerRequest>)=>{
  const {id,wasmUrl,request}=event.data;
  let response:WasmWorkerResponse;
  try{
    if(new URL(wasmUrl,self.location.origin).origin!==self.location.origin)throw new Error("Solver module must be served from this site.");
    engine??=fetch(wasmUrl).then(result=>{if(!result.ok)throw new Error(`Solver module download failed (HTTP ${result.status}).`);return WasmSolverEngine.load(result);});
    response={id,ok:true,raw:(await engine).solve(request)};
  }catch(error){
    // A trap can leave wasm memory inconsistent, so the next solve starts from a fresh instance.
    engine=null;
    response={id,ok:false,error:error instanceof Error?error.message:"In-browser solver failed."};
  }
  self.postMessage(response);
};
