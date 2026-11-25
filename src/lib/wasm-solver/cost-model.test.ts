import { describe, expect, it } from "vitest";
import { DEFAULT_ITERATION_COST_NS, expectedSolveMs, loadIterationCost, recordIterationCost } from "./cost-model";

function memoryStorage(initial:Record<string,string>={}){
  const values=new Map(Object.entries(initial));
  return {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},values};
}

describe("wasm iteration cost model",()=>{
  it("starts from measured per-street defaults",()=>{
    expect(loadIterationCost(memoryStorage(),"river")).toBe(DEFAULT_ITERATION_COST_NS.river);
    expect(loadIterationCost(memoryStorage(),"flop")).toBe(DEFAULT_ITERATION_COST_NS.flop);
  });
  it("blends each solve's measured cost into the stored estimate",()=>{
    const storage=memoryStorage();
    // 2000 ms over 1,000,000 units x 4 iterations = 500 ns per unit per iteration.
    const updated=recordIterationCost(storage,"flop",{elapsedMs:2000,workUnits:1_000_000,iterations:4});
    expect(updated).toBeCloseTo(DEFAULT_ITERATION_COST_NS.flop*0.6+500*0.4,5);
    expect(loadIterationCost(storage,"flop")).toBeCloseTo(updated,5);
    expect(loadIterationCost(storage,"turn")).toBe(DEFAULT_ITERATION_COST_NS.turn);
  });
  it("ignores unusable samples and corrupted storage",()=>{
    const storage=memoryStorage({"rangelab.wasmIterationCostNs":"{bad json"});
    expect(loadIterationCost(storage,"turn")).toBe(DEFAULT_ITERATION_COST_NS.turn);
    expect(recordIterationCost(storage,"turn",{elapsedMs:100,workUnits:0,iterations:4})).toBe(DEFAULT_ITERATION_COST_NS.turn);
    expect(loadIterationCost(memoryStorage({"rangelab.wasmIterationCostNs":'{"turn":-5}'}),"turn")).toBe(DEFAULT_ITERATION_COST_NS.turn);
    // Tampered values far from the measured default would plan absurd iteration counts.
    expect(loadIterationCost(memoryStorage({"rangelab.wasmIterationCostNs":'{"turn":1e-300}'}),"turn")).toBe(DEFAULT_ITERATION_COST_NS.turn);
    expect(loadIterationCost(memoryStorage({"rangelab.wasmIterationCostNs":'{"turn":1000000}'}),"turn")).toBe(DEFAULT_ITERATION_COST_NS.turn);
  });
  it("works without storage, e.g. when it is blocked",()=>{
    expect(loadIterationCost(undefined,"river")).toBe(DEFAULT_ITERATION_COST_NS.river);
    const throwing={getItem:()=>{throw new Error("blocked");},setItem:()=>{throw new Error("blocked");}};
    expect(loadIterationCost(throwing,"river")).toBe(DEFAULT_ITERATION_COST_NS.river);
    expect(()=>recordIterationCost(throwing,"river",{elapsedMs:10,workUnits:1000,iterations:100})).not.toThrow();
  });
  it("predicts the time of the minimum useful solve",()=>{
    expect(expectedSolveMs(300,1_000_000,3)).toBeCloseTo(900,5);
  });
});
