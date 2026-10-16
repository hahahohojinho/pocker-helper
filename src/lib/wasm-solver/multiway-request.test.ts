import { describe, expect, it } from "vitest";
import { parseSolverResult } from "../solver-adapter";
import { buildMultiwaySolveRequest, multiwayResponseToSolverJson, type MultiwaySolveInput } from "./multiway-request";

const input=(history:MultiwaySolveInput["history"],stacks=[97.5,97.5,97.5]):MultiwaySolveInput=>({
  board:["Ks","7d","2c","5h","3s"],heroHole:["Qc","Jc"],heroIndex:2,
  players:stacks.map((stack,index)=>({range:["AA,KK","QQ,JJ","QcJc,TT"][index],stack})),
  pot:8,history,iterations:1000,betPercent:[50],raisePercent:[60],timeBudgetMs:4500,
});

describe("buildMultiwaySolveRequest",()=>{
  it("encodes players, chips, and a check-bet line in action order",()=>{
    const request=buildMultiwaySolveRequest(input([{player:0,action:"check",amount:0},{player:1,action:"bet",amount:4}]));
    expect(request).toMatchObject({board:"Ks7d2c5h3s",hero:"QcJc",heroSeat:2,pot:800,maxRaises:2,timeBudgetMs:4500});
    expect(request.players.map(player=>player.stack)).toEqual([9750,9750,9750]);
    expect(request.history).toEqual([{action:"check"},{action:"bet",size:[1,2]}]);
    expect(request.betSizes).toEqual([[[1,2]],[[3,5]]]);
  });
  it("sizes a raise from the pot after calling the largest bet and merges observed sizes",()=>{
    // 8 + 3 bet = 11, call 3 -> 14; raise to 10 adds 7 = 1/2 of that pot.
    const request=buildMultiwaySolveRequest(input([{player:0,action:"bet",amount:3},{player:1,action:"raise",amount:10}]));
    expect(request.history).toEqual([{action:"bet",size:[3,8]},{action:"raise",size:[1,2]}]);
    expect(request.betSizes[0]).toEqual([[1,2],[3,8]]);
    expect(request.betSizes[1]).toEqual([[3,5],[1,2]]);
    expect(request.maxRaises).toBe(3);
  });
  it("maps calls and bets that need the whole stack to all-in, and keeps folds",()=>{
    const request=buildMultiwaySolveRequest(input([{player:0,action:"bet",amount:30},{player:1,action:"fold",amount:0},{player:2,action:"call",amount:20}],[97.5,97.5,20]));
    expect(request.history).toEqual([{action:"bet",size:[15,4]},{action:"fold"},{action:"allin"}]);
    const shove=buildMultiwaySolveRequest(input([{player:0,action:"bet",amount:97.5}]));
    expect(shove.history).toEqual([{action:"allin"}]);
    // A short all-in below the bet is a call for less, so the next raise is still the first raise level.
    const short=buildMultiwaySolveRequest(input([{player:0,action:"bet",amount:30},{player:1,action:"raise",amount:20},{player:2,action:"raise",amount:90}],[97.5,20,97.5]));
    expect(short.history.map(step=>step.action)).toEqual(["bet","allin","raise"]);
    expect(short.betSizes).toHaveLength(2);
    expect(short.maxRaises).toBe(3);
  });
  it("rejects unsupported spots before they reach the solver",()=>{
    expect(()=>buildMultiwaySolveRequest({...input([]),board:["Ks","7d","2c","5h"]})).toThrow("Board");
    expect(()=>buildMultiwaySolveRequest({...input([]),heroIndex:3})).toThrow("Hero");
    expect(()=>buildMultiwaySolveRequest(input([],[97.5,0,97.5]))).toThrow("positive");
    expect(()=>buildMultiwaySolveRequest(input([{player:5,action:"check",amount:0}]))).toThrow("unknown player");
    expect(()=>buildMultiwaySolveRequest(input([{player:0,action:"bet",amount:4},{player:1,action:"raise",amount:5}]))).toThrow("최소 레이즈");
  });
});

describe("multiwayResponseToSolverJson",()=>{
  const ok={ok:true as const,result:{source:"multiway-native",player:2,players:3,best_action:"call",iterations:340,stoppedBy:"deadline" as const,elapsedMs:4490,
    strategy:[{action:"call",frequency:0.7,evChips:150},{action:"fold",frequency:0.3,evChips:0}],convergence:{metric:"maxBrGainPctPot" as const,maxBrGain:0.02,brGain:[0.01,0.02,0.015]}}};
  it("converts EV to BB and reports max best-response gain instead of exploitability",()=>{
    const parsed=parseSolverResult(multiwayResponseToSolverJson(ok));
    expect(parsed.source).toBe("multiway-native");
    expect(parsed.evSource).toBe("solver");
    expect(parsed.actions.find(action=>action.action==="call")?.ev).toBe(1.5);
    expect(parsed.maxBrGain).toBe(0.02);
    expect(parsed.exploitability).toBeUndefined();
    expect(parsed.stoppedBy).toBe("deadline");
  });
  it("omits convergence it did not measure and surfaces solver errors",()=>{
    expect(parseSolverResult(multiwayResponseToSolverJson({...ok,result:{...ok.result,convergence:null}})).maxBrGain).toBeUndefined();
    expect(()=>multiwayResponseToSolverJson({ok:false,error:"history does not end at Hero's decision"})).toThrow("Multiway solver: history");
  });
});
