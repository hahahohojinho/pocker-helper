import type { WasmSolveRequest } from "./request";

export const DEFAULT_WASM_URL="/solver/rangelab_dcfr_wasm.wasm";

export interface WasmWorkerRequest { id:number;wasmUrl:string;request:WasmSolveRequest; }
export type WasmWorkerResponse={id:number;ok:true;raw:string}|{id:number;ok:false;error:string};
export interface WasmSolveOptions { timeoutMs:number;signal?:AbortSignal;wasmUrl?:string;createWorker?:()=>Worker; }

export const isWasmSolverSupported=()=>typeof WebAssembly==="object"&&typeof Worker==="function";

function createDefaultWorker(){
  return new Worker(new URL("../../workers/dcfr-solver.worker.ts",import.meta.url),{type:"module"});
}

let nextId=1;

/**
 * Solves in a dedicated worker so the page stays responsive. The worker is terminated on completion, timeout,
 * or abort, which also stops a solve that is still running. Resolves with normalized solver JSON.
 */
export function runWasmSolve(request:WasmSolveRequest,options:WasmSolveOptions):Promise<string>{
  return new Promise((resolve,reject)=>{
    if(options.signal?.aborted){reject(new Error("In-browser solve was cancelled."));return;}
    const worker=(options.createWorker??createDefaultWorker)();
    const id=nextId++;
    let settled=false;
    const finish=(outcome:()=>void)=>{
      if(settled)return;
      settled=true;clearTimeout(timer);options.signal?.removeEventListener("abort",onAbort);worker.terminate();outcome();
    };
    const onAbort=()=>finish(()=>reject(new Error("In-browser solve was cancelled.")));
    const timer=setTimeout(()=>finish(()=>reject(new Error(`In-browser solve timed out after ${Math.round(options.timeoutMs/1000)}s.`))),options.timeoutMs);
    options.signal?.addEventListener("abort",onAbort,{once:true});
    worker.onmessage=(event:MessageEvent<WasmWorkerResponse>)=>{
      const response=event.data;
      if(response.id!==id)return;
      finish(()=>response.ok?resolve(response.raw):reject(new Error(response.error)));
    };
    worker.onerror=(event:ErrorEvent)=>finish(()=>reject(new Error(event.message||"In-browser solver worker failed.")));
    worker.postMessage({id,wasmUrl:options.wasmUrl??DEFAULT_WASM_URL,request} satisfies WasmWorkerRequest);
  });
}
