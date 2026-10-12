import { afterEach, describe, expect, it, vi } from "vitest";
import { createSolverNode, type SolverHistoryAction } from "../solver-adapter";
import type { TexasSolverJob } from "../texas-solver-config";
import { buildDcfrJobRequest, replayJobHistory } from "./dcfr-job-request";

vi.mock("node:child_process",async importOriginal=>({...(await importOriginal<typeof import("node:child_process")>()),spawn:vi.fn()}));

const node=createSolverNode({street:"river",heroHole:["As","Qh"],board:["Js","7d","2c","9h","Kd"],pot:10,toCall:0,effectiveStack:90,candidateActions:["check","bet"]});
const job:TexasSolverJob={node,ranges:{oop:"AQo,JJ",ip:"AQo,KK"},tree:{betPercent:[50],raisePercent:[60],includeAllIn:false},accuracy:10,iterations:10,threads:1};
const withHistory=(actionHistory:SolverHistoryAction[]):TexasSolverJob=>({...job,actionHistory});
const stacks={oop:90,ip:90};

afterEach(()=>{vi.restoreAllMocks();delete process.env.DCFR_ADAPTER_PATH;});

describe("buildDcfrJobRequest",()=>{
  it("builds an OOP street-root request in chips",()=>{
    const {request,legalActions}=buildDcfrJobRequest(job);
    expect(request.history).toEqual([]);
    expect(request.pot).toBe(1000);
    expect(request.stacks).toEqual([9000,9000]);
    expect(request.hero).toBe("AsQh");
    expect([...legalActions].sort()).toEqual(["bet","check"]);
  });
  it("builds the IP root after a check",()=>{
    const {request,legalActions}=buildDcfrJobRequest(withHistory([{action:"check"}]));
    expect(request.history).toEqual([{action:"check"}]);
    expect([...legalActions].sort()).toEqual(["bet","check"]);
  });
  it("builds a node facing a bet and keeps all-in reported as bet legal",()=>{
    const {request,legalActions}=buildDcfrJobRequest(withHistory([{action:"bet",amount:5}]));
    expect(request.history).toEqual([{action:"bet",size:[1,2]}]);
    expect([...legalActions].sort()).toEqual(["bet","call","fold","raise"]);
  });
  it("adds observed raise sizes to the tree",()=>{
    const {request}=buildDcfrJobRequest(withHistory([{action:"check"},{action:"bet",amount:5},{action:"raise",amount:15}]));
    expect(request.history).toEqual([{action:"check"},{action:"bet",size:[1,2]},{action:"raise",size:[1,2]}]);
    expect(request.betSizes[1]).toEqual(expect.arrayContaining([[1,2]]));
    expect(request.maxRaises).toBe(3);
  });
  it("uses per-role stacks from the two players",()=>{
    const players=[{seat:2,range:"AQo,JJ",stack:120},{seat:5,range:"AQo,KK",stack:90}];
    expect(buildDcfrJobRequest({...job,players,actorSeat:2}).request.stacks).toEqual([12000,9000]);
    expect(buildDcfrJobRequest({...job,players,actorSeat:5,actionHistory:[{action:"check"}]}).request.stacks).toEqual([12000,9000]);
  });
  it("rejects jobs that are not a heads-up decision node",()=>{
    expect(()=>buildDcfrJobRequest({...job,node:{...node,toCall:2}})).toThrow("nothing to call");
    const three=[{seat:0,range:"AQo",stack:90},{seat:1,range:"JJ",stack:90},{seat:2,range:"77",stack:90}];
    expect(()=>buildDcfrJobRequest({...job,players:three,actorSeat:0})).toThrow("heads-up");
    const mismatched=[{seat:0,range:"AQo",stack:80},{seat:1,range:"JJ",stack:100}];
    expect(()=>buildDcfrJobRequest({...job,players:mismatched,actorSeat:0})).toThrow("effective stack");
  });
});

describe("replayJobHistory",()=>{
  it.each<[string,SolverHistoryAction[],string]>([
    ["fold",[{action:"bet",amount:5},{action:"fold"}],"fold"],
    ["check-check",[{action:"check"},{action:"check"}],"ends the street"],
    ["bet-call",[{action:"bet",amount:5},{action:"call",amount:5}],"ends the street"],
    ["call without a bet",[{action:"call"}],"without a bet"],
    ["check facing a bet",[{action:"bet",amount:5},{action:"check"}],"facing a bet"],
    ["raise first",[{action:"raise",amount:5}],"only bet"],
    ["bet facing a bet",[{action:"bet",amount:5},{action:"bet",amount:15}],"only raise"],
    ["missing amount",[{action:"bet"}],"needs an amount"],
    ["raise not above the bet",[{action:"bet",amount:5},{action:"raise",amount:5}],"does not exceed"],
    ["bet above the stack",[{action:"bet",amount:91}],"exceeds"],
    ["raise above the stack",[{action:"bet",amount:50},{action:"raise",amount:95}],"exceeds"],
    ["actions after the street",[{action:"check"},{action:"check"},{action:"bet",amount:5}],"continues"],
  ])("rejects %s",(_label,history,message)=>{
    expect(()=>replayJobHistory(history,stacks)).toThrow(message);
  });
  it("rejects raising an all-in when the raiser has more chips",()=>{
    expect(()=>replayJobHistory([{action:"bet",amount:50},{action:"raise",amount:60}],{oop:50,ip:90})).toThrow("all-in");
  });
  it("treats a bet covering the shorter stack as all-in",()=>{
    const {request}=buildDcfrJobRequest({...job,players:[{seat:0,range:"AQo,JJ",stack:120},{seat:1,range:"AQo,KK",stack:90}],actorSeat:1,actionHistory:[{action:"bet",amount:100}]});
    expect(request.history).toEqual([{action:"allin"}]);
  });
  it("tracks the actor and recomputes call amounts",()=>{
    const replayed=replayJobHistory([{action:"check"},{action:"bet",amount:5},{action:"raise",amount:15}],stacks);
    expect(replayed.actor).toBe("ip");
    expect(replayed.facingBet).toBe(true);
    expect(replayed.steps.map(step=>step.role)).toEqual(["oop","ip","oop"]);
  });
});

describe("runDcfrAdapter",()=>{
  it("rejects an action that is not legal at the node",async()=>{
    const adapter=await import("./run-dcfr-adapter");
    const childProcess=await import("node:child_process");
    const { EventEmitter }=await import("node:events");
    const { PassThrough }=await import("node:stream");
    process.env.DCFR_ADAPTER_PATH="C:/bin/rangelab-dcfr-adapter.exe";
    vi.mocked(childProcess.spawn).mockImplementation(()=>{
      const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),stdin:new PassThrough(),kill:vi.fn()});
      const envelope={ok:true,result:{source:"dcfr-native",player:"ip",best_action:"fold",exploitability:0.1,strategy:[{action:"fold",frequency:1,evChips:0}]}};
      queueMicrotask(()=>{child.stdout.end(JSON.stringify(envelope));child.emit("close",0);});
      return child as unknown as ReturnType<typeof childProcess.spawn>;
    });
    await expect(adapter.runDcfrAdapter(withHistory([{action:"check"}]),5_000)).rejects.toThrow("not legal");
  });
});
