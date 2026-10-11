import { describe, expect, it, vi } from "vitest";
import { NativeSolverUnavailableError, runNativeSolve } from "./native-client";
import type { WasmSolveRequest } from "./request";

const request={board:"JsTd7c2h3s",hero:"AsQh",oopRange:"AA",ipRange:"KK",pot:1000,stacks:[9000,9000],iterations:10,betSizes:[[[1,2]]],maxRaises:2,history:[]} as WasmSolveRequest;
const reply=(status:number,body:unknown)=>vi.fn(async()=>new Response(JSON.stringify(body),{status}));

describe("native solver client",()=>{
  it("posts a dcfr-json body and returns the solver JSON",async()=>{
    const fetchImpl=reply(200,{source:"dcfr-native"});
    await expect(runNativeSolve(request,{fetchImpl})).resolves.toBe('{"source":"dcfr-native"}');
    const [url,init]=fetchImpl.mock.calls[0] as unknown as [string,RequestInit];
    expect(url).toBe("/api/solver");
    expect(JSON.parse(String(init.body))).toEqual({kind:"dcfr-json",request});
  });
  it("signals fallback when the server cannot run it",async()=>{
    await expect(runNativeSolve(request,{fetchImpl:reply(404,{error:"Native DCFR solver is not enabled."})})).rejects.toBeInstanceOf(NativeSolverUnavailableError);
    await expect(runNativeSolve(request,{fetchImpl:reply(403,{error:"disabled"})})).rejects.toBeInstanceOf(NativeSolverUnavailableError);
    await expect(runNativeSolve(request,{fetchImpl:vi.fn(async()=>{throw new TypeError("Failed to fetch");})})).rejects.toBeInstanceOf(NativeSolverUnavailableError);
  });
  it("reports other failures without fallback",async()=>{
    const busy=runNativeSolve(request,{fetchImpl:reply(429,{error:"다른 Solver 작업이 실행 중입니다."})});
    await expect(busy).rejects.toThrow(/실행 중/);
    await expect(busy).rejects.not.toBeInstanceOf(NativeSolverUnavailableError);
  });
  it("treats an aborted request as a cancellation",async()=>{
    const controller=new AbortController();controller.abort();
    const fetchImpl=vi.fn(async()=>{throw new DOMException("aborted","AbortError");});
    await expect(runNativeSolve(request,{signal:controller.signal,fetchImpl})).rejects.toThrow(/cancelled/);
  });
});
