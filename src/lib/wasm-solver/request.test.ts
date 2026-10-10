import { describe, expect, it } from "vitest";
import { buildWasmSolveRequest, wasmResponseToSolverJson, type WasmSolveInput } from "./request";
import { parseSolverResult } from "../solver-adapter";

const input:WasmSolveInput={board:["Js","Td","7c","2h","3s"],heroHole:["As","Qh"],oopRange:"AsQh:1,KK",ipRange:"QQ,AJs",pot:10,stacks:{oop:90,ip:90},history:[],iterations:500,betPercent:[50],raisePercent:[60]};

describe("wasm solve request",()=>{
  it("converts BB amounts to 1/100 BB chips and reduced base fractions",()=>{
    expect(buildWasmSolveRequest(input)).toEqual({board:"JsTd7c2h3s",hero:"AsQh",oopRange:"AsQh:1,KK",ipRange:"QQ,AJs",pot:1000,stacks:[9000,9000],iterations:500,betSizes:[[[1,2]],[[3,5]]],maxRaises:2,history:[]});
  });
  it("encodes an observed bet as an exact fraction of the current pot",()=>{
    const request=buildWasmSolveRequest({...input,history:[{role:"oop",action:"bet",amount:12}]});
    expect(request.history).toEqual([{action:"bet",size:[6,5]}]);
    expect(request.betSizes[0]).toEqual([[1,2],[6,5]]);
  });
  it("encodes a raise as the increment over the bet divided by the pot after calling",()=>{
    // Pot 10, OOP bets 5, IP raises to 20: increment 15 over pot-after-call 10 + 5 + 5 = 20 -> 3/4.
    const request=buildWasmSolveRequest({...input,history:[{role:"oop",action:"check",amount:0},{role:"ip",action:"bet",amount:5},{role:"oop",action:"raise",amount:20}]});
    expect(request.history).toEqual([{action:"check"},{action:"bet",size:[1,2]},{action:"raise",size:[3,4]}]);
    expect(request.betSizes).toEqual([[[1,2]],[[3,5],[3,4]]]);
    expect(request.maxRaises).toBe(3);
  });
  it("tracks both players' street commitments for a re-raise",()=>{
    // Bet 5, raise to 20, re-raise to 60: increment 40 over pot 10 + 5 + 20 + 15 = 50 -> 4/5.
    const request=buildWasmSolveRequest({...input,history:[{role:"oop",action:"bet",amount:5},{role:"ip",action:"raise",amount:20},{role:"oop",action:"raise",amount:60}]});
    expect(request.history.at(-1)).toEqual({action:"raise",size:[4,5]});
    expect(request.betSizes).toHaveLength(3);
    expect(request.betSizes[2]).toEqual([[3,5],[4,5]]);
    expect(request.maxRaises).toBe(4);
  });
  it("maps stack-sized bets and calls to the all-in action",()=>{
    const shove=buildWasmSolveRequest({...input,stacks:{oop:30,ip:90},history:[{role:"oop",action:"bet",amount:30}]});
    expect(shove.history).toEqual([{action:"allin"}]);
    const call=buildWasmSolveRequest({...input,stacks:{oop:90,ip:20},history:[{role:"oop",action:"bet",amount:25},{role:"ip",action:"call",amount:20}]});
    expect(call.history.at(-1)).toEqual({action:"allin"});
  });
  it("explains a re-raise smaller than the solver tree's minimum",()=>{
    // Bet 10, raise to 30, re-raise to 50: the solver needs an increment of at least 30 - 0.01 over the 30 bet.
    const history=[{role:"oop",action:"bet",amount:10},{role:"ip",action:"raise",amount:30},{role:"oop",action:"raise",amount:50}] as const;
    expect(()=>buildWasmSolveRequest({...input,history:[...history]})).toThrow(/최소 레이즈/);
    expect(()=>buildWasmSolveRequest({...input,history:[...history.slice(0,2),{role:"oop",action:"raise",amount:60}]})).not.toThrow();
  });
  it("rejects histories beyond the solver raise cap",()=>{
    const history=[{role:"oop",action:"bet",amount:2},{role:"ip",action:"raise",amount:6},{role:"oop",action:"raise",amount:14},{role:"ip",action:"raise",amount:30}] as const;
    expect(()=>buildWasmSolveRequest({...input,stacks:{oop:500,ip:500},history:[...history]})).toThrow(/raise/);
  });
  it("rejects invalid cards and non-positive pots",()=>{
    expect(()=>buildWasmSolveRequest({...input,board:["Js","Td"]})).toThrow();
    expect(()=>buildWasmSolveRequest({...input,pot:0})).toThrow();
  });
});

describe("wasm solve response",()=>{
  it("converts chip EVs to BB in the normalized solver format",()=>{
    const raw=wasmResponseToSolverJson({ok:true,result:{source:"dcfr-wasm",player:"oop",best_action:"check",exploitability:0.02,strategy:[{action:"check",frequency:0.75,evChips:46.9},{action:"bet",frequency:0.25,evChips:19.1}]}});
    const parsed=parseSolverResult(raw);
    expect(parsed.evSource).toBe("solver");
    expect(parsed.exploitability).toBe(0.02);
    expect(parsed.actions.find(item=>item.action==="check")).toMatchObject({frequency:75,ev:0.469});
  });
  it("adds a note when Hero's combo is never reached at equilibrium",()=>{
    const raw=wasmResponseToSolverJson({ok:true,result:{source:"dcfr-wasm",player:"ip",best_action:"call",exploitability:0.1,heroUnreached:true,strategy:[{action:"call",frequency:1,evChips:10},{action:"fold",frequency:0,evChips:0}]}});
    expect((JSON.parse(raw) as {note?:string}).note).toMatch(/도달하지 않/);
  });
  it("surfaces solver errors",()=>{
    expect(()=>wasmResponseToSolverJson({ok:false,error:"history does not reach a decision node"})).toThrow(/history/);
  });
});
