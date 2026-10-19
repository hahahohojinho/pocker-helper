import { describe, expect, it } from "vitest";
import { buildWasmSolveRequest, wasmResponseToSolverJson, type WasmSolveInput } from "./request";
import { parseSolverResult } from "../solver-adapter";
import { nativeTimeBudget } from "../solver-guard";
import { getSolverPreset } from "../solver-presets";

const input:WasmSolveInput={board:["Js","Td","7c","2h","3s"],heroHole:["As","Qh"],oopRange:"AsQh,KK",ipRange:"QQ",pot:10,stacks:{oop:90,ip:90},history:[],iterations:500,betPercent:[50],raisePercent:[60]};

describe("time-budgeted solve requests",()=>{
  it("sends the budget and wasm cost only when given",()=>{
    expect(buildWasmSolveRequest(input)).not.toHaveProperty("timeBudgetMs");
    expect(buildWasmSolveRequest({...input,timeBudgetMs:4500.4,iterationCostNs:300})).toMatchObject({timeBudgetMs:4500,iterationCostNs:300});
  });
  it("keeps every DCFR preset inside the 10 second answer limit and turn/river near 5 seconds",()=>{
    for(const backend of ["wasm","native","multiway"] as const)for(const street of ["flop","turn","river"] as const){
      const budget=getSolverPreset(backend,street).timeBudgetMs!;
      expect(budget).toBeLessThan(10_000);
      // Live flops and 3-way turns use most of the 10 s limit; everything else stays near 5 s.
      if((street!=="flop"&&!(backend==="multiway"&&street==="turn"))||backend==="wasm")expect(budget).toBeLessThan(5000);
    }
  });
  it("passes iterations, stop reason, and work units through the normalized result",()=>{
    const raw=wasmResponseToSolverJson({ok:true,result:{source:"dcfr-native",player:"oop",best_action:"bet",exploitability:null,iterations:22,stoppedBy:"deadline",elapsedMs:4310,workUnits:7_572_480,strategy:[{action:"bet",frequency:0.6,evChips:120},{action:"check",frequency:0.4,evChips:110}]}});
    const parsed=parseSolverResult(raw);
    expect(parsed).toMatchObject({iterations:22,stoppedBy:"deadline",workUnits:7_572_480});
    expect(parsed.exploitability).toBeUndefined();
  });
});

describe("native time budget",()=>{
  it("caps the request and subtracts time already spent",()=>{
    expect(nativeTimeBudget(4500,undefined,100)).toBe(4500-100-150);
    expect(nativeTimeBudget(60_000,"8000",0)).toBe(8000-150);
    expect(nativeTimeBudget(4500,undefined,10_000)).toBe(200);
  });
  it("applies the server maximum when the client sends no usable budget",()=>{
    expect(nativeTimeBudget(undefined,undefined,0)).toBe(10_000-150);
    expect(nativeTimeBudget("4500","6000",0)).toBe(6000-150);
  });
});
