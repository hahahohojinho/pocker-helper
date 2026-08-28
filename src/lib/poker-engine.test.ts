import { describe, expect, it } from "vitest";
import { calculateEquity } from "./equity";
import type { PlayerAction } from "./game-state";
import { derivePreflopSpotContext, recommendFromHistory } from "./game-state";
import { deriveBettingState, validatePreflopAction } from "./preflop-machine";
import { availableActions } from "./preflop-machine";
import type { Position } from "./preflop";
import { activeStrategyDataset, allStartingHands, buildStrategyMatrix, bundledStrategyDatasetId, clearStrategyDataset, installStrategyDataset, lookupStrategy, normalizeStartingHand, parseStrategyDatasetJson } from "./strategy-data";
import { createSolverNode, parseSolverResult, parseTexasSolverNode, parseTexasSolverNodeAtHistory } from "./solver-adapter";
import { calculatePokerPots, calculatePotLayers, totalPot } from "./pots";
import { buildTexasSolverCommands } from "./texas-solver-config";
import { buildPostflopContext, nextPostflopActor } from "./postflop-hand-state";
import type { PostflopAction } from "./postflop-machine";
import { attachActionEvs } from "./decision-ev";
import { calculateRangeEquity, parseWeightedRange } from "./range-equity";
import { conditionRangeOnPostflop, ensureComboInRange, inferRangeFromPreflop, toTexasSolverRange } from "./range-model";

const positions:Position[]=["BTN","SB","BB","UTG","HJ","CO"];
const action=(seat:number,type:PlayerAction["type"],amount:number):PlayerAction=>({id:`${seat}-${type}`,street:"preflop",seat,position:positions[seat],type,amount});
const postAction=(street:PostflopAction["street"],seat:number,type:PostflopAction["type"],amount=0):PostflopAction=>({id:`${street}-${seat}-${type}`,street,seat,position:positions[seat],type,amount});

describe("preflop accounting",()=>{
  it("counts latest contribution once and preserves blinds",()=>{
    const actions=[action(4,"open",2.5),action(5,"call",2.5),action(0,"3bet",10),action(4,"call",10),action(5,"fold",0)];
    const state=deriveBettingState(actions,positions);
    expect(state.pot).toBe(24);
    expect(state.contributions.get(4)).toBe(10);
  });
  it("rejects a raise below the legal minimum",()=>{
    const actions=[action(4,"open",3)];
    const result=validatePreflopAction({actions,positions,seat:5,type:"3bet",amount:4.5,effectiveStack:100});
    expect(result.valid).toBe(false);
    expect(result.minimumAmount).toBe(5);
  });
  it("does not reopen raising after a short all-in",()=>{
    const actions=[action(4,"open",10),action(5,"call",10),action(0,"3bet",15)];
    const stacks=[15,100,100,100,100,100];
    expect(availableActions(actions,positions,4,stacks)).toEqual(["fold","call"]);
    expect(availableActions(actions,positions,1,stacks)).toContain("4bet");
  });
  it("offers a 5-bet after a full 4-bet",()=>{
    const actions=[action(4,"open",2.5),action(5,"3bet",8),action(0,"4bet",20)];
    expect(availableActions(actions,positions,4,100)).toContain("5bet");
  });
  it("uses scenario-correct recommendation labels",()=>{
    const unopened=recommendFromHistory({heroPosition:"BTN",hand:"AA",effectiveStack:100,actions:[]});
    expect(unopened.displayFrequencies.map(item=>item.action)).toEqual(["Fold","Limp","Open"]);
    const facingThreeBet=recommendFromHistory({heroPosition:"BTN",hand:"AA",effectiveStack:100,actions:[action(4,"open",2.5),action(5,"3bet",9)]});
    expect(facingThreeBet.displayFrequencies.map(item=>item.action)).toContain("4-bet");
  });
});

describe("side pots",()=>{
  it("builds main and side pots while excluding folded players from eligibility",()=>{
    const contributions=new Map([[0,20],[1,50],[2,100],[3,100]]);
    const pots=calculatePotLayers(contributions,new Set([3]));
    expect(pots.map(pot=>pot.amount)).toEqual([80,90,100]);
    expect(pots[2].eligibleSeats).toEqual([2]);
    expect(totalPot(pots)).toBe(270);
  });
  it("keeps a single pot when no player is all-in",()=>{
    const contributions=new Map([[0,2.5],[1,0.5],[2,1],[3,2.5]]);
    const pots=calculatePokerPots(contributions,new Set([1,2]),new Set());
    expect(pots).toHaveLength(1);
    expect(pots[0].amount).toBe(6.5);
  });
  it("uses only all-in caps to split poker pots",()=>{
    const contributions=new Map([[0,20],[1,50],[2,100],[3,100]]);
    const pots=calculatePokerPots(contributions,new Set([3]),new Set([0,1]));
    expect(pots.map(pot=>pot.amount)).toEqual([80,90,100]);
  });
});

describe("postflop state persistence",()=>{
  it("carries pot and remaining stacks into the next street and skips all-in seats",()=>{
    const actions=[postAction("flop",0,"check"),postAction("flop",1,"bet",40),postAction("flop",2,"call",40),postAction("flop",0,"call",40)];
    const turn=buildPostflopContext({actions,street:"turn",seats:[0,1,2],initialRemaining:[90,40,90],initialPot:10});
    expect(turn.potBefore).toBe(130);
    expect(turn.remainingAtStart).toEqual([50,0,50]);
    expect(turn.allInSeats.has(1)).toBe(true);
    expect(nextPostflopActor(turn,[0,1,2])).toBe(0);
  });
  it("keeps a flop fold inactive on the turn",()=>{
    const actions=[postAction("flop",0,"fold"),postAction("flop",1,"check"),postAction("flop",2,"check")];
    const turn=buildPostflopContext({actions,street:"turn",seats:[0,1,2],initialRemaining:[90,90,90],initialPot:10});
    expect(turn.foldedSeats.has(0)).toBe(true);
    expect(nextPostflopActor(turn,[0,1,2])).toBe(1);
  });
});

describe("169 hand strategy",()=>{
  it("loads the bundled 100M-iteration DCFR RFI dataset by default",()=>{
    clearStrategyDataset();
    expect(activeStrategyDataset()).toMatchObject({id:bundledStrategyDatasetId,contract:"rangelab.preflop_strategy.v2",spots:5,provenance:{iterations:100_000_000,seed:42,revision:"4ade6a9e15a841c41867afde1258b9d110cd6fb1"}});
    expect(lookupStrategy({hand:"AA",position:"BTN",stack:100,scenario:"unopened"}).source).toBe(`dataset:${bundledStrategyDatasetId}`);
  });
  it("derives v2 opener, caller positions, and latest sizing from action history",()=>{
    const actions:PlayerAction[]=[
      {id:"1",street:"preflop",seat:0,position:"CO",type:"open",amount:2.5},
      {id:"2",street:"preflop",seat:1,position:"BTN",type:"call",amount:2.5},
      {id:"3",street:"preflop",seat:2,position:"SB",type:"3bet",amount:10},
    ];
    expect(derivePreflopSpotContext(actions)).toEqual({openerPosition:"CO",callerPositions:["BTN"],actionSize:10});
  });
  it("contains 169 unique normalized starting hands",()=>{
    expect(allStartingHands).toHaveLength(169);
    expect(new Set(allStartingHands).size).toBe(169);
    expect(normalizeStartingHand("qaS")).toBe("AQs");
  });
  it("returns a complete strategy matrix",()=>expect(buildStrategyMatrix("BTN",100,"single-open")).toHaveLength(169));
  it("only installs complete, licensed 169-hand dataset spots",()=>{
    expect(()=>installStrategyDataset({id:"bad",license:"",generatedAt:"2026-08-26",rows:[]})).toThrow();
    installStrategyDataset({id:"test-v1",license:"MIT",generatedAt:"2026-08-26",rows:allStartingHands.map(hand=>({hand,position:"BTN",stack:100,scenario:"unopened",fold:0,passive:0,aggressive:100}))});
    expect(lookupStrategy({hand:"72o",position:"BTN",stack:100,scenario:"unopened"})).toMatchObject({aggressive:100,source:"dataset:test-v1"});
    clearStrategyDataset();
  });
  it("parses a versioned JSON dataset and rejects malformed rows",()=>{
    const rows=allStartingHands.map(hand=>({hand,position:"BTN",stack:100,scenario:"unopened",fold:10,passive:20,aggressive:70}));
    const parsed=parseStrategyDatasetJson(JSON.stringify({id:"json-v1",license:"MIT",generatedAt:"2026-08-26",rows}));
    expect(parsed.rows).toHaveLength(169);
    clearStrategyDataset();
    expect(()=>parseStrategyDatasetJson(JSON.stringify({id:"bad",license:"MIT",generatedAt:"2026-08-26",rows:[{hand:"AA"}]}))).toThrow("missing or invalid fields");
  });
  it("prefers an exact v2 opener, callers, and nearest sizing spot over a v1-compatible wildcard",()=>{
    const wildcard=allStartingHands.map(hand=>({hand,position:"BTN" as const,stack:100 as const,scenario:"open-with-callers" as const,fold:100,passive:0,aggressive:0}));
    const exact=(actionSize:number,aggressive:number)=>allStartingHands.map(hand=>({hand,position:"BTN" as const,stack:100 as const,scenario:"open-with-callers" as const,openerPosition:"CO" as const,callerPositions:["SB" as const],actionSize,fold:100-aggressive,passive:0,aggressive}));
    installStrategyDataset({contract:"rangelab.preflop_strategy.v2",id:"context-v2",license:"MIT",generatedAt:"2026-08-27",rows:[...wildcard,...exact(2.5,70),...exact(4,90)]});
    expect(lookupStrategy({hand:"AQs",position:"BTN",stack:100,scenario:"open-with-callers",openerPosition:"CO",callerPositions:["SB"],actionSize:3.8})).toMatchObject({aggressive:90,source:"dataset:context-v2"});
    expect(lookupStrategy({hand:"AQs",position:"BTN",stack:100,scenario:"open-with-callers",openerPosition:"HJ",callerPositions:["SB"],actionSize:3.8})).toMatchObject({fold:100});
    clearStrategyDataset();
  });
});

describe("action inferred ranges",()=>{
  it("narrows an observed open to a weighted range",()=>{
    const actions:PlayerAction[]=[{id:"1",street:"preflop",seat:0,position:"UTG",type:"open",amount:2.5}];
    const range=inferRangeFromPreflop({actions,seat:0,position:"UTG",stack:100});
    expect(range.source).toBe("action-baseline-v1");
    expect(range.handCount).toBeLessThan(169);
    expect(range.text).toContain("AA:1");
  });
  it("updates a range after a later decision",()=>{
    const actions:PlayerAction[]=[
      {id:"1",street:"preflop",seat:0,position:"UTG",type:"open",amount:2.5},
      {id:"2",street:"preflop",seat:1,position:"CO",type:"3bet",amount:8},
      {id:"3",street:"preflop",seat:0,position:"UTG",type:"call",amount:8},
    ];
    const openOnly=inferRangeFromPreflop({actions:actions.slice(0,1),seat:0,position:"UTG",stack:100});
    const continued=inferRangeFromPreflop({actions,seat:0,position:"UTG",stack:100});
    expect(continued.text).not.toBe(openOnly.text);
  });
  it("accounts for unusually large raise sizing",()=>{
    const action=(amount:number):PlayerAction[]=>[{id:"1",street:"preflop",seat:0,position:"UTG",type:"open",amount}];
    const normal=inferRangeFromPreflop({actions:action(2.5),seat:0,position:"UTG",stack:100});
    const large=inferRangeFromPreflop({actions:action(5),seat:0,position:"UTG",stack:100});
    expect(large.text).not.toBe(normal.text);
  });
  it("conditions a range on board-aware postflop aggression",()=>{
    const initial="AA,KK,QQ,JJ,TT,99,88,77,66,55,44,33,22,AKs,AQs,KQs";
    const aggressive=conditionRangeOnPostflop({rangeText:initial,boardCodes:["As","7d","2c"],actions:["bet","raise"]});
    expect(aggressive).not.toBe(initial);
    expect(parseWeightedRange(aggressive).length).toBeGreaterThan(0);
  });
  it("retains flush and straight draws in an aggressive conditioned range",()=>{
    const result=conditionRangeOnPostflop({rangeText:"AhKh:1,9c8c:1,3c3d:1",boardCodes:["2h","7h","6s"],actions:["bet","raise"]});
    const combos=parseWeightedRange(result);
    expect(combos.some(combo=>combo.cards.join("")==="AhKh")).toBe(true);
    expect(combos.some(combo=>combo.cards.join("")==="9c8c")).toBe(true);
  });
  it("weights a nut-flush blocker as an aggressive bluff candidate",()=>{
    const result=conditionRangeOnPostflop({rangeText:"AhQc:1,AdQd:1,9h8h:1",boardCodes:["Kh","7h","2h","5c","9s"],actions:["bet"]});
    const combos=parseWeightedRange(result);
    const blocker=combos.find(combo=>combo.cards.join("")==="AhQc")!;
    const noBlocker=combos.find(combo=>combo.cards.join("")==="AdQd")!;
    expect(blocker.weight).toBeGreaterThan(noBlocker.weight);
  });
  it("keeps the observed hero combo in a solver range",()=>{
    expect(ensureComboInRange("AA,KK",["7s","2h"])).toContain("7s2h:0.01");
    expect(ensureComboInRange("72o",["7s","2h"])).toBe("72o");
  });
  it("aggregates exact suit combos to TexasSolver weighted 169 classes",()=>{
    const range=toTexasSolverRange("AsQh:0.5,AcQd:1,KhKc:0.75",["7s","2h"]);
    expect(range).toContain("AQo:0.75");
    expect(range).toContain("KK:0.75");
    expect(range).toContain("72o:0.01");
    expect(range).not.toMatch(/[AKQJT2-9][cdhs][AKQJT2-9][cdhs]/);
  });
  it("prunes solver ranges while retaining the required hero class",()=>{
    const range=toTexasSolverRange(allStartingHands.join(","),["7s","2h"],0.01,5);
    expect(range.split(",")).toHaveLength(5);
    expect(range).toContain("72o:");
  });
  it("builds native-compatible ranges for the browser smoke spot",()=>{
    const actions:PlayerAction[]=[
      {id:"1",street:"preflop",seat:5,position:"CO",type:"open",amount:2.5},
      {id:"2",street:"preflop",seat:0,position:"BTN",type:"call",amount:2.5},
    ];
    const hero=toTexasSolverRange(inferRangeFromPreflop({actions,seat:5,position:"CO",stack:100}).text,["As","Qh"],0.01,24);
    const villain=toTexasSolverRange(inferRangeFromPreflop({actions,seat:0,position:"BTN",stack:100}).text,undefined,0.01,24);
    expect(hero.split(",")).toHaveLength(24);
    expect(villain.split(",")).toHaveLength(24);
    expect(`${hero}\n${villain}`).not.toMatch(/[AKQJT2-9][cdhs][AKQJT2-9][cdhs]/);
  });
});

describe("equity",()=>{
  it("recognizes the dominant equity of pocket aces heads-up",()=>{
    const result=calculateEquity(["As","Ah"],[],1,2500);
    expect(result.equity).toBeGreaterThan(75);
    expect(result.win+result.tie+result.loss).toBeCloseTo(100,0);
  });
  it("rejects duplicated known cards",()=>expect(()=>calculateEquity(["As","As"],[],1,10)).toThrow());
  it("expands standard weighted range notation into suit combos",()=>{
    expect(parseWeightedRange("AA")).toHaveLength(6);
    expect(parseWeightedRange("AKs")).toHaveLength(4);
    expect(parseWeightedRange("AKo")).toHaveLength(12);
    expect(parseWeightedRange("AK")).toHaveLength(16);
    expect(parseWeightedRange("AsQh:0.5")[0]).toMatchObject({cards:["As","Qh"],weight:0.5});
  });
  it("calculates equity against a weighted opponent range",()=>{
    const result=calculateRangeEquity(["As","Ah"],[],["KK,QQ"],2500);
    expect(result.mode).toBe("weighted-range");
    expect(result.availableCombos).toEqual([12]);
    expect(result.equity).toBeGreaterThan(75);
  });
});

describe("solver adapter",()=>{
  it("normalizes imported action frequencies",()=>{
    const result=parseSolverResult('{"source":"texassolver","actions":{"check":0.35,"bet":0.65}}');
    expect(result.source).toBe("texassolver");
    expect(result.bestAction).toBe("bet");
    expect(result.actions.find(item=>item.action==="bet")?.frequency).toBe(65);
    expect(result.evSource).toBe("unavailable");
  });
  it("parses a TexasSolver native combo strategy node",()=>{
    const raw=JSON.stringify({strategy:{actions:["CHECK","BET 50","BET 100"],strategy:{AsQh:[0.25,0.5,0.25]}}});
    const result=parseTexasSolverNode(raw,"AsQh");
    expect(result.source).toBe("texassolver");
    expect(result.actions.find(item=>item.action==="bet")?.frequency).toBe(75);
  });
  it("creates a versioned solver node and rejects duplicate cards",()=>{
    const node=createSolverNode({street:"flop",heroHole:["As","Qh"],board:["2c","7d","Jh"],pot:10,toCall:5,effectiveStack:95,candidateActions:["fold","call","raise"]});
    expect(node.contract).toBe("rangelab.solver_node.v1");
    expect(()=>createSolverNode({...node,heroHole:["As","As"]})).toThrow();
  });
  it("selects an IP strategy from a native intermediate action node",()=>{
    const raw=JSON.stringify({childrens:{CHECK:{strategy:{actions:["CHECK","BET 5.000000"],strategy:{AsQh:[0.25,0.75]}}},"BET 3.000000":{childrens:{CALL:{strategy:{actions:["CHECK","BET 8.000000"],strategy:{AsQh:[0.6,0.4]}}}}}}});
    const afterCheck=parseTexasSolverNodeAtHistory(raw,"AsQh",[{action:"check"}]);
    expect(afterCheck.actions).toEqual([{action:"check",frequency:25},{action:"bet",frequency:75}]);
    const afterBetCall=parseTexasSolverNodeAtHistory(raw,"AsQh",[{action:"bet",amount:3},{action:"call",amount:3}]);
    expect(afterBetCall.bestAction).toBe("check");
  });
  it("preserves solver EV and labels model fallback EV",()=>{
    const strategy=attachActionEvs([{action:"call",frequency:70,ev:3.2},{action:"fold",frequency:30}],[{action:"fold",ev:0,assumption:"baseline"}]);
    expect(strategy[0]).toMatchObject({ev:3.2,evSource:"solver"});
    expect(strategy[1]).toMatchObject({ev:0,evSource:"model"});
  });
});

describe("TexasSolver command builder",()=>{
  it("builds a bounded flop solve command without isomorphism",()=>{
    const node=createSolverNode({street:"flop",heroHole:["As","Qh"],board:["Js","7d","2c"],pot:10,toCall:0,effectiveStack:90,candidateActions:["check","bet"]});
    const command=buildTexasSolverCommands({node,ranges:{oop:"AA,KK,QQ,AKs",ip:"JJ,TT,AQs,AQo"},tree:{betPercent:[33,75],raisePercent:[60],includeAllIn:true},accuracy:1,iterations:100,threads:4});
    expect(command).toContain("set_board Js,7d,2c");
    expect(command).toContain("set_bet_sizes oop,flop,bet,33,75");
    expect(command).toContain("set_use_isomorphism 0");
    expect(command).toContain("set_allin_threshold 1.0");
    expect(command).toContain("dump_result output_result.json");
  });
  it("rejects newline command injection in ranges",()=>{
    const node=createSolverNode({street:"flop",heroHole:["As","Qh"],board:["Js","7d","2c"],pot:10,toCall:0,effectiveStack:90,candidateActions:["check","bet"]});
    expect(()=>buildTexasSolverCommands({node,ranges:{oop:"AA\nstart_solve",ip:"KK"},tree:{betPercent:[50],raisePercent:[50],includeAllIn:false},accuracy:1,iterations:10,threads:1})).toThrow();
  });
  it("accepts decimal combo weights used by inferred ranges",()=>{
    const node=createSolverNode({street:"flop",heroHole:["As","Qh"],board:["Js","7d","2c"],pot:10,toCall:0,effectiveStack:90,candidateActions:["check","bet"]});
    expect(buildTexasSolverCommands({node,ranges:{oop:"AQo:0.75,AsQh:0.01",ip:"KK:1"},tree:{betPercent:[50],raisePercent:[50],includeAllIn:false},accuracy:1,iterations:10,threads:1})).toContain("set_range_oop AQo:0.75,AsQh:0.01");
  });
  it("builds turn and river root jobs with matching board lengths",()=>{
    for(const [street,board] of [["turn",["Js","7d","2c","Kh"]],["river",["Js","7d","2c","Kh","4s"]]] as const){
      const node=createSolverNode({street,heroHole:["As","Qh"],board:[...board],pot:20,toCall:0,effectiveStack:80,candidateActions:["check","bet"]});
      const command=buildTexasSolverCommands({node,ranges:{oop:"AA,KK",ip:"QQ,JJ"},tree:{betPercent:[50],raisePercent:[60],includeAllIn:false},accuracy:1,iterations:10,threads:1});
      expect(command).toContain(`set_board ${board.join(",")}`);
    }
  });
});
