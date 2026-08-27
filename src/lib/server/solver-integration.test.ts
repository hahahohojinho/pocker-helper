import { describe, expect, it } from "vitest";
import { createSolverNode } from "../solver-adapter";
import type { TexasSolverJob } from "../texas-solver-config";
import { runTexasSolver } from "./run-texas-solver-core";
import { afterEach, vi } from "vitest";
import { runCounterfactualBackend } from "./run-counterfactual-backend";

const solverAvailable=Boolean(process.env.TEXAS_SOLVER_PATH);

afterEach(()=>{delete process.env.COUNTERFACTUAL_EV_BACKEND_URL;delete process.env.COUNTERFACTUAL_EV_BACKEND_TOKEN;vi.restoreAllMocks();});

describe("Counterfactual EV backend",()=>{
  it("posts a solver job and requires normalized solver EV output",async()=>{
    process.env.COUNTERFACTUAL_EV_BACKEND_URL="https://solver.example/v1/solve";
    process.env.COUNTERFACTUAL_EV_BACKEND_TOKEN="secret";
    const raw=JSON.stringify({source:"openspiel",strategy:[{action:"check",frequency:0.4,ev:1.2},{action:"bet",frequency:0.6,ev:1.8}],best_action:"bet"});
    const fetchMock=vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(raw,{status:200,headers:{"content-type":"application/json"}}));
    const node=createSolverNode({street:"flop",heroHole:["As","Qh"],board:["Js","7d","2c"],pot:10,toCall:0,effectiveStack:90,candidateActions:["check","bet"]});
    const job:TexasSolverJob={node,ranges:{oop:"AQo",ip:"JJ"},tree:{betPercent:[50],raisePercent:[60],includeAllIn:false},accuracy:10,iterations:10,threads:1};
    expect(await runCounterfactualBackend(job)).toBe(raw);
    expect(fetchMock).toHaveBeenCalledWith(new URL("https://solver.example/v1/solve"),expect.objectContaining({method:"POST",headers:expect.objectContaining({authorization:"Bearer secret"})}));
  });
  it("rejects a backend response outside the solver contract",async()=>{
    process.env.COUNTERFACTUAL_EV_BACKEND_URL="https://solver.example/v1/solve";
    vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response('{"ok":true}',{status:200}));
    const node=createSolverNode({street:"flop",heroHole:["As","Qh"],board:["Js","7d","2c"],pot:10,toCall:0,effectiveStack:90,candidateActions:["check","bet"]});
    const job:TexasSolverJob={node,ranges:{oop:"AQo",ip:"JJ"},tree:{betPercent:[50],raisePercent:[60],includeAllIn:false},accuracy:10,iterations:10,threads:1};
    await expect(runCounterfactualBackend(job)).rejects.toThrow("actions 또는 strategy");
  });
  it("rejects missing EV and invalid jobs before fetch",async()=>{
    process.env.COUNTERFACTUAL_EV_BACKEND_URL="https://solver.example/v1/solve";
    const fetchMock=vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(JSON.stringify({strategy:[{action:"check",frequency:1}]}),{status:200}));
    const node=createSolverNode({street:"flop",heroHole:["As","Qh"],board:["Js","7d","2c"],pot:10,toCall:0,effectiveStack:90,candidateActions:["check","bet"]});
    const job:TexasSolverJob={node,ranges:{oop:"AQo",ip:"JJ"},tree:{betPercent:[50],raisePercent:[60],includeAllIn:false},accuracy:10,iterations:10,threads:1};
    await expect(runCounterfactualBackend(job)).rejects.toThrow("include EV for every action");
    fetchMock.mockClear();
    await expect(runCounterfactualBackend({...job,iterations:0})).rejects.toThrow("Iterations");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("TexasSolver local integration",()=>{
  it.skipIf(!solverAvailable)("runs bounded flop, turn, and river root solves",async()=>{
    const streets=[["flop",["Qs","8d","7h"]],["turn",["Qs","8d","7h","2c"]],["river",["Qs","8d","7h","2c","Ah"]]] as const;
    for(const [street,board] of streets){
      const node=createSolverNode({street,heroHole:["Ts","9s"],board:[...board],pot:4,toCall:0,effectiveStack:10,candidateActions:["check","bet"]});
      const job:TexasSolverJob={node,ranges:{ip:"T9s",oop:"JTs,43s"},tree:{betPercent:[50],raisePercent:[60],includeAllIn:false},accuracy:10,iterations:10,threads:1};
      const raw=await runTexasSolver(job,30_000);
      const result=JSON.parse(raw) as {strategy?:{actions?:string[]}};
      expect(result.strategy?.actions?.[0]).toBe("CHECK");
      expect(result.strategy?.actions?.[1]).toMatch(/^BET /);
    }
  },35_000);
});
