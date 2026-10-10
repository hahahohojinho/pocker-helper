import { afterEach, describe, expect, it, vi } from "vitest";
import { runWasmSolve, type WasmWorkerRequest, type WasmWorkerResponse } from "./client";
import type { WasmSolveRequest } from "./request";

const request={board:"JsTd7c2h3s",hero:"AsQh",oopRange:"AA",ipRange:"KK",pot:1000,stacks:[9000,9000],iterations:10,betSizes:[[[1,2]]],maxRaises:2,history:[]} as WasmSolveRequest;

class FakeWorker{
  onmessage:((event:MessageEvent<WasmWorkerResponse>)=>void)|null=null;
  onerror:((event:ErrorEvent)=>void)|null=null;
  posted:WasmWorkerRequest[]=[];
  terminate=vi.fn();
  postMessage(message:WasmWorkerRequest){this.posted.push(message);}
  reply(response:{ok:true;raw:string}|{ok:false;error:string},id=this.posted[0].id){this.onmessage?.({data:{...response,id}} as MessageEvent<WasmWorkerResponse>);}
}

afterEach(()=>vi.useRealTimers());

describe("wasm solver client",()=>{
  it("resolves with the worker's solver JSON and terminates the worker",async()=>{
    const worker=new FakeWorker();
    const result=runWasmSolve(request,{timeoutMs:1000,createWorker:()=>worker as unknown as Worker});
    expect(worker.posted[0]).toMatchObject({request,wasmUrl:"/solver/rangelab_dcfr_wasm.wasm"});
    worker.reply({ok:true,raw:'{"source":"dcfr-wasm"}'});
    await expect(result).resolves.toBe('{"source":"dcfr-wasm"}');
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it("rejects with the solver error and ignores replies for other requests",async()=>{
    const worker=new FakeWorker();
    const result=runWasmSolve(request,{timeoutMs:1000,createWorker:()=>worker as unknown as Worker});
    worker.reply({ok:true,raw:"stale"},-1);
    worker.reply({ok:false,error:"hero combo is not in the acting player's range"});
    await expect(result).rejects.toThrow(/hero combo/);
  });
  it("terminates a solve that exceeds the timeout",async()=>{
    vi.useFakeTimers();
    const worker=new FakeWorker();
    const result=runWasmSolve(request,{timeoutMs:5000,createWorker:()=>worker as unknown as Worker});
    vi.advanceTimersByTime(5000);
    await expect(result).rejects.toThrow(/timed out after 5s/);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it("cancels on abort and refuses an already-aborted signal",async()=>{
    const worker=new FakeWorker();const controller=new AbortController();
    const result=runWasmSolve(request,{timeoutMs:5000,signal:controller.signal,createWorker:()=>worker as unknown as Worker});
    controller.abort();
    await expect(result).rejects.toThrow(/cancelled/);
    expect(worker.terminate).toHaveBeenCalledOnce();
    const factory=vi.fn();
    await expect(runWasmSolve(request,{timeoutMs:5000,signal:controller.signal,createWorker:factory})).rejects.toThrow(/cancelled/);
    expect(factory).not.toHaveBeenCalled();
  });
  it("rejects when the worker itself fails",async()=>{
    const worker=new FakeWorker();
    const result=runWasmSolve(request,{timeoutMs:5000,createWorker:()=>worker as unknown as Worker});
    worker.onerror?.({message:"module load failed"} as ErrorEvent);
    await expect(result).rejects.toThrow(/module load failed/);
  });
});
