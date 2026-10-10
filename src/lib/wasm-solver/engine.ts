import { wasmResponseToSolverJson, type WasmSolveRequest, type WasmSolveResponse } from "./request";

interface SolverExports {
  memory:WebAssembly.Memory;
  alloc(len:number):number;
  dealloc(pointer:number,len:number):void;
  solve(pointer:number,len:number):void;
  result_ptr():number;
  result_len():number;
}

/** Thin wrapper over the raw exports of rangelab_dcfr_wasm.wasm; runs synchronously, so call it from a worker. */
export class WasmSolverEngine {
  private constructor(private readonly exports:SolverExports){}

  static async load(bytes:BufferSource|Response){
    const source=bytes instanceof Response?await bytes.arrayBuffer():bytes;
    const {instance}=await WebAssembly.instantiate(source,{});
    return new WasmSolverEngine(instance.exports as unknown as SolverExports);
  }

  solveRaw(request:WasmSolveRequest):WasmSolveResponse{
    const input=new TextEncoder().encode(JSON.stringify(request));
    const pointer=this.exports.alloc(input.length);
    try{
      new Uint8Array(this.exports.memory.buffer,pointer,input.length).set(input);
      this.exports.solve(pointer,input.length);
    }finally{
      // After a trap the instance is unusable and dealloc may throw too; keep the original error.
      try{this.exports.dealloc(pointer,input.length);}catch{}
    }
    const output=new Uint8Array(this.exports.memory.buffer,this.exports.result_ptr(),this.exports.result_len());
    return JSON.parse(new TextDecoder().decode(output)) as WasmSolveResponse;
  }

  /** Normalized solver JSON (see parseSolverResult) for Hero's decision at the request's history node. */
  solve(request:WasmSolveRequest){
    return wasmResponseToSolverJson(this.solveRaw(request));
  }
}
