import { describe, expect, it } from "vitest";
import { createSolverNode } from "./solver-adapter";
import { exploitabilityLevel, getSolverPreset, parseTexasSolverLog, resolveSolverThreads, resolveSolverTimeoutMs, type SolverBackend } from "./solver-presets";
import { clampSolverBudget, isTrustedSolverRequest, tryAcquireSolverSlot } from "./solver-guard";
import { buildTexasSolverCommands, validateTexasSolverJob } from "./texas-solver-config";

const boards={flop:["Js","7d","2c"],turn:["Js","7d","2c","Kh"],river:["Js","7d","2c","Kh","4s"]} as const;

describe("solver presets",()=>{
  it("produces valid jobs for every backend and street",()=>{
    for(const backend of ["texassolver","dcfr","counterfactual"] as SolverBackend[])for(const street of ["flop","turn","river"] as const){
      const preset=getSolverPreset(backend,street);
      const node=createSolverNode({street,heroHole:["As","Qh"],board:[...boards[street]],pot:10,toCall:0,effectiveStack:90,candidateActions:["check","bet"]});
      expect(()=>validateTexasSolverJob({node,ranges:{oop:"AA",ip:"KK"},tree:preset.tree,accuracy:preset.accuracy,iterations:preset.iterations,threads:preset.threads,useIsomorphism:preset.useIsomorphism})).not.toThrow();
      expect(preset.iterations).toBeGreaterThanOrEqual(100);
      expect(preset.accuracy).toBeLessThanOrEqual(2);
      expect(preset.maxClasses).toBe(Number.POSITIVE_INFINITY);
    }
  });
  it("spends more iterations on later streets with smaller trees",()=>{
    expect(getSolverPreset("texassolver","river").iterations).toBeGreaterThan(getSolverPreset("texassolver","flop").iterations);
  });
});

describe("solver resource limits",()=>{
  it("clamps threads to the request, configured maximum, CPU count, and 32",()=>{
    expect(resolveSolverThreads(32,undefined,8)).toBe(8);
    expect(resolveSolverThreads(4,undefined,8)).toBe(4);
    expect(resolveSolverThreads(32,"2",8)).toBe(2);
    expect(resolveSolverThreads(32,"abc",8)).toBe(8);
    expect(resolveSolverThreads(32,"0",8)).toBe(8);
    expect(resolveSolverThreads(64,"999",128)).toBe(32);
    expect(resolveSolverThreads(0,undefined,8)).toBe(1);
  });
  it("reads a bounded timeout from the environment",()=>{
    expect(resolveSolverTimeoutMs(undefined)).toBe(300_000);
    expect(resolveSolverTimeoutMs("abc")).toBe(300_000);
    expect(resolveSolverTimeoutMs("60000")).toBe(60_000);
    expect(resolveSolverTimeoutMs("1")).toBe(10_000);
    expect(resolveSolverTimeoutMs("99999999")).toBe(1_800_000);
  });
});

describe("solver convergence",()=>{
  it("reads the last exploitability line from a TexasSolver log",()=>{
    const log='noise\n{"exploitibility":34.5,"iteration":5,"time_ms":50142}\n{"exploitibility":0.8,"iteration":40,"time_ms":90000}\n';
    expect(parseTexasSolverLog(log)).toEqual({exploitability:0.8,iteration:40,timeMs:90000});
    expect(parseTexasSolverLog('{"exploitability":1.5,"iteration":3}')).toEqual({exploitability:1.5,iteration:3,timeMs:undefined});
    expect(parseTexasSolverLog("")).toEqual({});
    expect(parseTexasSolverLog("{broken\nplain text")).toEqual({});
  });
  it("classifies exploitability as a percentage of the pot",()=>{
    expect(exploitabilityLevel(undefined)).toBe("unknown");
    expect(exploitabilityLevel(0.4)).toBe("ok");
    expect(exploitabilityLevel(1)).toBe("ok");
    expect(exploitabilityLevel(3)).toBe("warn");
    expect(exploitabilityLevel(34.5)).toBe("bad");
    expect(exploitabilityLevel(Number.NaN)).toBe("unknown");
  });
});

describe("TexasSolver command options",()=>{
  const node=createSolverNode({street:"flop",heroHole:["As","Qh"],board:["Js","7d","2c"],pot:10,toCall:0,effectiveStack:90,candidateActions:["check","bet"]});
  const job={node,ranges:{oop:"AA",ip:"KK"},tree:{betPercent:[50],raisePercent:[60],includeAllIn:false},accuracy:1,iterations:200,threads:4};
  it("enables isomorphism only when requested",()=>{
    expect(buildTexasSolverCommands({...job,useIsomorphism:true})).toContain("set_use_isomorphism 1");
    expect(buildTexasSolverCommands(job)).toContain("set_use_isomorphism 0");
  });
  it("scales the print interval with the iteration budget",()=>{
    expect(buildTexasSolverCommands(job)).toContain("set_print_interval 20");
    expect(buildTexasSolverCommands({...job,iterations:10})).toContain("set_print_interval 1");
  });
  it("rejects carriage returns and tabs in ranges",()=>{
    expect(()=>buildTexasSolverCommands({...job,ranges:{oop:"AA\rstart_solve",ip:"KK"}})).toThrow();
    expect(()=>buildTexasSolverCommands({...job,ranges:{oop:"AA\tKK",ip:"KK"}})).toThrow();
  });
});

describe("solver API guards",()=>{
  it("caps client iterations and floors accuracy on the server",()=>{
    expect(clampSolverBudget({iterations:5000,accuracy:0.0001},undefined)).toEqual({iterations:1000,accuracy:0.1});
    expect(clampSolverBudget({iterations:200,accuracy:1},undefined)).toEqual({iterations:200,accuracy:1});
    expect(clampSolverBudget({iterations:5000,accuracy:1},"300")).toEqual({iterations:300,accuracy:1});
  });
  it("limits concurrent solves and releases a slot once",()=>{
    const first=tryAcquireSolverSlot("1");
    expect(first).not.toBeNull();
    expect(tryAcquireSolverSlot("1")).toBeNull();
    first!();first!();
    const second=tryAcquireSolverSlot("1");
    expect(second).not.toBeNull();
    const third=tryAcquireSolverSlot("2");
    expect(third).not.toBeNull();
    second!();third!();
  });
  it("accepts only same-origin JSON requests",()=>{
    const headers=(values:Record<string,string>)=>new Headers(values);
    expect(isTrustedSolverRequest(headers({"content-type":"application/json","sec-fetch-site":"same-origin"}))).toBe(true);
    expect(isTrustedSolverRequest(headers({"content-type":"application/json; charset=utf-8"}))).toBe(true);
    expect(isTrustedSolverRequest(headers({"content-type":"text/plain","sec-fetch-site":"same-origin"}))).toBe(false);
    expect(isTrustedSolverRequest(headers({"content-type":"application/json","sec-fetch-site":"cross-site"}))).toBe(false);
    expect(isTrustedSolverRequest(headers({"content-type":"application/json","origin":"https://evil.example","host":"localhost:3000"}))).toBe(false);
    expect(isTrustedSolverRequest(headers({"content-type":"application/json","origin":"http://localhost:3000","host":"localhost:3000"}))).toBe(true);
  });
});

describe("solver tree size limits",()=>{
  it("deduplicates merged street sizes and caps the merged list",()=>{
    const node=createSolverNode({street:"flop",heroHole:["As","Qh"],board:["Js","7d","2c"],pot:10,toCall:0,effectiveStack:90,candidateActions:["check","bet"]});
    const job={node,ranges:{oop:"AA",ip:"KK"},accuracy:1,iterations:10,threads:1};
    expect(buildTexasSolverCommands({...job,tree:{betPercent:[50],raisePercent:[60],includeAllIn:false,streetBetPercent:[50,120]}})).toContain("set_bet_sizes oop,flop,bet,50,120\n");
    expect(()=>buildTexasSolverCommands({...job,tree:{betPercent:[10,20,30,40,50],raisePercent:[60],includeAllIn:false,streetBetPercent:[60,70,80,90]}})).toThrow(/최대/);
  });
});
