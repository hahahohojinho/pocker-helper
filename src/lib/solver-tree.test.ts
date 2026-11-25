import { describe, expect, it } from "vitest";
import { buildSolverTree } from "./solver-tree";
import { createSolverNode, parseTexasSolverNodeAtHistory } from "./solver-adapter";
import { buildTexasSolverCommands } from "./texas-solver-config";

const base={betPercent:[50],raisePercent:[60],includeAllIn:false};

describe("observed-size solver tree",()=>{
  it("adds an observed bet as a percent of the street-start pot",()=>{
    expect(buildSolverTree(base,[{action:"bet",amount:12}],10)).toMatchObject({streetBetPercent:[120],streetRaisePercent:[]});
  });
  it("converts a raise-to amount with TexasSolver's pot-after-call formula",()=>{
    // raiseTo = B + r * (P0 + 2B): 20 = 5 + r * (10 + 10) -> r = 75%.
    expect(buildSolverTree(base,[{action:"bet",amount:5},{action:"raise",amount:20}],10)).toMatchObject({streetBetPercent:[],streetRaisePercent:[75]});
  });
  it("does not duplicate a size already in the base tree",()=>{
    expect(buildSolverTree(base,[{action:"bet",amount:5},{action:"call",amount:5}],10)).toMatchObject({streetBetPercent:[],streetRaisePercent:[]});
  });
  it("uses an all-in branch only when the oversized amount is the all-in",()=>{
    const tree=buildSolverTree(base,[{action:"bet",amount:60}],10,60);
    expect(tree.includeAllIn).toBe(true);
    expect(tree.streetBetPercent).toEqual([]);
    expect(()=>buildSolverTree(base,[{action:"bet",amount:60}],10,90)).toThrow(/500/);
  });
  it("sizes from TexasSolver's 1BB-rounded amounts so later raises still resolve",()=>{
    // Bet 2.5 is solved as 3 (30%); the raise to 10 is then 7 over B=3 -> 7 / (10 + 6) = 43.75%.
    expect(buildSolverTree(base,[{action:"bet",amount:2.5},{action:"raise",amount:10}],10)).toMatchObject({streetBetPercent:[30],streetRaisePercent:[43.75]});
  });
  it("skips an observed size that rounds to the same amount as a base size",()=>{
    // 50% of 5 is 2.5, which TexasSolver rounds to 3, the same as the observed 2.5.
    expect(buildSolverTree(base,[{action:"bet",amount:2.5}],5)).toMatchObject({streetBetPercent:[]});
  });
  it("emits observed sizes only for the solved street",()=>{
    const node=createSolverNode({street:"turn",heroHole:["As","Qh"],board:["Js","7d","2c","Kh"],pot:10,toCall:0,effectiveStack:90,candidateActions:["check","bet"]});
    const tree=buildSolverTree(base,[{action:"bet",amount:12}],10);
    const command=buildTexasSolverCommands({node,ranges:{oop:"AA",ip:"KK"},tree,accuracy:1,iterations:10,threads:1});
    expect(command).toContain("set_bet_sizes oop,turn,bet,50,120");
    expect(command).toContain("set_bet_sizes oop,river,bet,50\n");
    expect(command).toContain("set_bet_sizes oop,flop,bet,50\n");
  });
});

describe("history lookup tolerance",()=>{
  const node=(children:Record<string,unknown>)=>JSON.stringify({childrens:Object.fromEntries(Object.entries(children).map(([key,value])=>[key,{strategy:{actions:["CALL","FOLD"],strategy:{AsQh:[value,1-(value as number)]}}}]))});
  it("rejects a bet whose nearest native size is far from the observed amount",()=>{
    expect(()=>parseTexasSolverNodeAtHistory(node({"BET 5.000000":0.5}),"AsQh",[{action:"bet",amount:12}])).toThrow(/12.*5/);
  });
  it("selects the matching size when several exist",()=>{
    const result=parseTexasSolverNodeAtHistory(node({"BET 5.000000":0.2,"BET 12.000000":0.9}),"AsQh",[{action:"bet",amount:12}]);
    expect(result.actions.find(action=>action.action==="call")?.frequency).toBeCloseTo(90,5);
  });
  it("accepts rounding within 10% and rejects larger gaps",()=>{
    expect(()=>parseTexasSolverNodeAtHistory(node({"BET 10.000000":0.5}),"AsQh",[{action:"bet",amount:10.9}])).not.toThrow();
    expect(()=>parseTexasSolverNodeAtHistory(node({"BET 10.000000":0.5}),"AsQh",[{action:"bet",amount:11.3}])).toThrow();
  });
  it("compares against the 1BB-rounded observed amount",()=>{
    const result=parseTexasSolverNodeAtHistory(node({"BET 2.000000":0.2,"BET 3.000000":0.9}),"AsQh",[{action:"bet",amount:2.5}]);
    expect(result.actions.find(action=>action.action==="call")?.frequency).toBeCloseTo(90,5);
  });
  it("rejects an ambiguous match between two different sizes",()=>{
    expect(()=>parseTexasSolverNodeAtHistory(node({"BET 27.000000":0.2,"BET 33.000000":0.9}),"AsQh",[{action:"bet",amount:30}])).toThrow(/ambiguous/);
  });
  it("ignores malformed native size keys",()=>{
    expect(()=>parseTexasSolverNodeAtHistory(node({"BET 1.2.3":0.5}),"AsQh",[{action:"bet",amount:5}])).toThrow(/available: none/);
  });
  it("matches raise-to amounts and an all-in child by stack",()=>{
    expect(()=>parseTexasSolverNodeAtHistory(node({"RAISE 15.000000":0.5}),"AsQh",[{action:"raise",amount:15}])).not.toThrow();
    expect(()=>parseTexasSolverNodeAtHistory(node({"ALLIN":0.5}),"AsQh",[{action:"bet",amount:90}],{allInAmount:90})).not.toThrow();
    expect(()=>parseTexasSolverNodeAtHistory(node({"ALLIN":0.5}),"AsQh",[{action:"bet",amount:30}],{allInAmount:90})).toThrow();
  });
});
