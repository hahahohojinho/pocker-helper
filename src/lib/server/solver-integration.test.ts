import { describe, expect, it } from "vitest";
import { createSolverNode, parseTexasSolverNodeAtHistory } from "../solver-adapter";
import type { TexasSolverJob } from "../texas-solver-config";
import { runTexasSolver } from "./run-texas-solver-core";
import { afterEach, vi } from "vitest";
import { runCounterfactualBackend } from "./run-counterfactual-backend";
import { buildDcfrAdapterArgs, runDcfrAdapter } from "./run-dcfr-adapter";

const solverAvailable=Boolean(process.env.TEXAS_SOLVER_PATH);
const dcfrAdapterAvailable=Boolean(process.env.DCFR_ADAPTER_PATH);

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
  it("forwards validated multiway player ranges to the remote backend",async()=>{
    process.env.COUNTERFACTUAL_EV_BACKEND_URL="https://solver.example/v1/solve";
    const raw=JSON.stringify({source:"openspiel",strategy:[{action:"check",frequency:1,ev:2.1}],best_action:"check"});
    const fetchMock=vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(raw,{status:200}));
    const node=createSolverNode({street:"flop",heroHole:["As","Qh"],board:["Js","7d","2c"],pot:12,toCall:0,effectiveStack:80,candidateActions:["check","bet"]});
    const players=[{seat:0,range:"AQo",stack:80},{seat:1,range:"JJ",stack:75},{seat:2,range:"77",stack:60}];
    const job:TexasSolverJob={node,ranges:{oop:"AQo",ip:"JJ"},tree:{betPercent:[50],raisePercent:[60],includeAllIn:false},accuracy:10,iterations:10,threads:1,players,actorSeat:0};
    await runCounterfactualBackend(job);
    const body=JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as TexasSolverJob;
    expect(body.players).toEqual(players);
    expect(body.actorSeat).toBe(0);
  });
});

describe("Local DCFR counterfactual EV adapter",()=>{
  it("builds bounded root-solve arguments and rejects unsupported nodes",()=>{
    const node=createSolverNode({street:"river",heroHole:["As","Qh"],board:["Js","7d","2c","9h","Kd"],pot:10,toCall:0,effectiveStack:90,candidateActions:["check","bet"]});
    const job:TexasSolverJob={node,ranges:{oop:"AQo",ip:"JJ"},tree:{betPercent:[50],raisePercent:[60],includeAllIn:false},accuracy:10,iterations:10,threads:1};
    expect(buildDcfrAdapterArgs(job)).toContain("1000");
    expect(()=>buildDcfrAdapterArgs({...job,actionHistory:[{action:"check"}]})).toThrow("street root");
    expect(()=>buildDcfrAdapterArgs({...job,node:{...node,toCall:2}})).toThrow("nothing to call");
    expect(()=>buildDcfrAdapterArgs({...job,players:[{seat:0,range:"AQo",stack:90},{seat:1,range:"JJ",stack:90},{seat:2,range:"77",stack:90}],actorSeat:0})).toThrow("heads-up");
  });
  it.skipIf(!dcfrAdapterAvailable)("returns action-specific solver EV for a real river root",async()=>{
    const node=createSolverNode({street:"river",heroHole:["As","Qh"],board:["Js","7d","2c","9h","Kd"],pot:10,toCall:0,effectiveStack:90,candidateActions:["check","bet"]});
    const job:TexasSolverJob={node,ranges:{oop:"AQo",ip:"JJ"},tree:{betPercent:[50],raisePercent:[60],includeAllIn:false},accuracy:10,iterations:10,threads:1};
    const result=JSON.parse(await runDcfrAdapter(job,30_000)) as {strategy:Array<{action:string;ev:number}>};
    expect(result.strategy.map(action=>action.action).sort()).toEqual(["bet","check"]);
    expect(new Set(result.strategy.map(action=>action.ev)).size).toBe(2);
    expect(result.strategy.find(action=>action.action==="bet")!.ev).toBeGreaterThan(-6);
    expect(Math.abs(result.strategy.find(action=>action.action==="check")!.ev)).toBeLessThan(0.1);
  },35_000);
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
      const ipResult=parseTexasSolverNodeAtHistory(raw,"Ts9s",[{action:"check"}]);
      expect(ipResult.actions.map(action=>action.action)).toEqual(["check","bet"]);
    }
  },35_000);
});
