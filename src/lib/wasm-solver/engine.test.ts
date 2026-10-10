import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WasmSolverEngine } from "./engine";
import { buildWasmSolveRequest, type WasmSolveInput } from "./request";
import { parseSolverResult } from "../solver-adapter";

const wasmPath=join(process.cwd(),"public","solver","rangelab_dcfr_wasm.wasm");
const range="AA,KK,QQ,JJ,TT,99,AKs,AQs,AJs,KQs,QJs,JTs,T9s,98s,AKo,AQo,AsQh";
const river:WasmSolveInput={board:["Js","Td","7c","2h","3s"],heroHole:["As","Qh"],oopRange:range,ipRange:range,pot:10,stacks:{oop:90,ip:90},history:[],iterations:300,betPercent:[50],raisePercent:[60]};

describe.skipIf(!existsSync(wasmPath))("in-browser DCFR engine (real wasm)",()=>{
  const engine=WasmSolverEngine.load(readFileSync(wasmPath));
  it("solves an OOP river root with solver EV for every action",async()=>{
    const result=parseSolverResult((await engine).solve(buildWasmSolveRequest(river)));
    expect(result.evSource).toBe("solver");
    expect(result.actions.map(item=>item.action).sort()).toEqual(["bet","check"]);
    expect(result.exploitability).toBeLessThan(1);
  });
  it("reaches an IP node facing an observed non-default raise",async()=>{
    const history=[{role:"oop",action:"bet",amount:7},{role:"ip",action:"raise",amount:25},{role:"oop",action:"raise",amount:61}] as const;
    const result=parseSolverResult((await engine).solve(buildWasmSolveRequest({...river,history:[...history]})));
    expect(result.actions.map(item=>item.action)).toEqual(expect.arrayContaining(["fold","call"]));
  });
  it("reports an invalid range instead of trapping",async()=>{
    await expect(engine.then(value=>value.solve(buildWasmSolveRequest({...river,oopRange:"ZZ"})))).rejects.toThrow(/invalid OOP range/);
  });
});
