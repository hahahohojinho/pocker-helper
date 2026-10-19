import { describe, expect, it } from "vitest";
import { parseSolverResult } from "../solver-adapter";
import { buildMultiwaySolveRequest, multiwayResponseToSolverJson, streetStartPotLayers, type MultiwaySolveInput } from "./multiway-request";

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
    expect(()=>buildMultiwaySolveRequest({...input([]),board:["Ks","7d","2c"]})).toThrow("Board");
    expect(buildMultiwaySolveRequest({...input([]),board:["Ks","7d","2c","5h"]}).board).toBe("Ks7d2c5h");
    expect(()=>buildMultiwaySolveRequest({...input([]),heroIndex:3})).toThrow("Hero");
    expect(()=>buildMultiwaySolveRequest(input([],[97.5,97.5,0]))).toThrow("positive");
    expect(()=>buildMultiwaySolveRequest(input([{player:5,action:"check",amount:0}]))).toThrow("unknown player");
    expect(()=>buildMultiwaySolveRequest(input([{player:0,action:"bet",amount:4},{player:1,action:"raise",amount:5}]))).toThrow("최소 레이즈");
  });
});

describe("earlier-street side pots",()=>{
  it("splits the pot by contribution and keeps a player all-in earlier at a zero stack",()=>{
    // Seats 0-2 still in (solver order 2,0,1); seat 1 went all-in for 20; seat 3 folded after putting in 30.
    const committed=new Map([[0,50],[1,20],[2,50],[3,30]]);
    const layers=streetStartPotLayers({committed,players:[2,0,1],pot:150.5});
    // 20 x4 = 80 (+0.5 dead money) for everyone; 10 x3 + 20 x2 = 70 for seats 0 and 2 (one pot: same players).
    expect(layers).toEqual([{amount:80.5,eligible:[0,1,2]},{amount:70,eligible:[0,1]}]);
    const request=buildMultiwaySolveRequest({...input([],[97.5,97.5,0]),heroIndex:0,pot:150.5,potLayers:layers});
    expect(request.players.map(player=>player.stack)).toEqual([9750,9750,0]);
    expect(request.potLayers).toEqual([{amount:8050,eligible:[0,1,2]},{amount:7000,eligible:[0,1]}]);
  });
  it("sends no layers for a single pot, including folded blinds and float noise",()=>{
    expect(streetStartPotLayers({committed:new Map([[0,10],[1,10],[2,10]]),players:[0,1,2],pot:30})).toBeUndefined();
    // Folded 0.5, 1, and 3 are separate levels with the same live players; 97.3-84.9 and 100.7-88.3 are both 12.4.
    const committed=new Map([[0,0.5],[1,1],[2,3],[3,97.3-84.9],[4,100.7-88.3],[5,12.4]]);
    expect(streetStartPotLayers({committed,players:[3,4,5],pot:41.7})).toBeUndefined();
  });
  it("rejects contributions above the pot",()=>{
    expect(()=>streetStartPotLayers({committed:new Map([[0,50],[1,20],[2,50]]),players:[0,1,2],pot:100})).toThrow("exceed");
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
    expect(parsed.riverModel).toBeUndefined();
    expect(parseSolverResult(multiwayResponseToSolverJson({...ok,result:{...ok.result,riverModel:"checkdown"}})).riverModel).toBe("checkdown");
  });
  it("omits convergence it did not measure and surfaces solver errors",()=>{
    expect(parseSolverResult(multiwayResponseToSolverJson({...ok,result:{...ok.result,convergence:null}})).maxBrGain).toBeUndefined();
    expect(()=>multiwayResponseToSolverJson({ok:false,error:"history does not end at Hero's decision"})).toThrow("Multiway solver: history");
  });
});
