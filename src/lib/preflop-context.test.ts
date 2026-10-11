import { afterEach, describe, expect, it } from "vitest";
import { classifyPreflop, derivePreflopSpotContext, recommendFromHistory, type PlayerAction } from "./game-state";
import type { Position } from "./preflop";
import { clearPreflopPacks, installPreflopPack, parsePreflopPack } from "./preflop-packs";
import { inferRangeFromPreflop } from "./range-model";
import { allStartingHands, lookupStrategy } from "./strategy-data";

const act=(position:Position,type:PlayerAction["type"],amount=0):PlayerAction=>({id:`${position}-${type}-${amount}`,street:"preflop",seat:0,position,type,amount});
const hands=["22",...allStartingHands.filter(hand=>hand!=="22")];
const uniform=(fold:number,passive:number)=>hands.map(()=>[fold,passive]);

function installSixMaxPack(){
  installPreflopPack(parsePreflopPack(JSON.stringify({
    contract:"rangelab.preflop_pack.v1",id:"dcfr-6max-100bb-v1",license:"MIT",generatedAt:"2026-10-11",tableSize:6,stack:100,provenance:{},hands,
    spots:[
      {position:"BB",scenario:"limped",callerPositions:[],limperPositions:["SB"],reach:0.05,unreached:0,mix:uniform(0,600)},
      {position:"CO",scenario:"facing-3bet",openerPosition:"CO",aggressorPosition:"BTN",callerPositions:[],limperPositions:[],actionSize:"9",reach:0.01,unreached:0,mix:uniform(450,400)},
      {position:"BTN",scenario:"single-open",openerPosition:"CO",aggressorPosition:"CO",callerPositions:[],limperPositions:[],actionSize:"2.5",reach:0.05,unreached:0,mix:uniform(700,200)},
      // The solved model never lets UTG limp: passive is zero for every hand.
      {position:"UTG",scenario:"unopened",callerPositions:[],limperPositions:[],reach:1,unreached:0,mix:uniform(800,0)},
      {position:"UTG",scenario:"facing-4bet",openerPosition:"UTG",aggressorPosition:"CO",callerPositions:[],limperPositions:[],actionSize:"22",reach:0.001,unreached:0,mix:uniform(300,300)},
    ],
  })));
}

afterEach(()=>clearPreflopPacks());

describe("preflop spot context",()=>{
  it("classifies a limped pot and records limpers",()=>{
    const actions=[act("UTG","fold"),act("HJ","fold"),act("CO","fold"),act("BTN","fold"),act("SB","limp",1)];
    expect(classifyPreflop(actions)).toBe("limped");
    expect(derivePreflopSpotContext(actions)).toMatchObject({limperPositions:["SB"],callerPositions:[]});
  });
  it("records the latest aggressor separately from the opener",()=>{
    const actions=[act("UTG","fold"),act("HJ","fold"),act("CO","open",2.5),act("BTN","3bet",9),act("SB","fold"),act("BB","fold")];
    expect(classifyPreflop(actions)).toBe("facing-3bet");
    expect(derivePreflopSpotContext(actions)).toMatchObject({openerPosition:"CO",aggressorPosition:"BTN",actionSize:9});
  });
});

describe("pack-backed recommendations",()=>{
  it("prefers the solved pack when the table size is known",()=>{
    installSixMaxPack();
    const actions=[act("UTG","fold"),act("HJ","fold"),act("CO","open",2.5),act("BTN","3bet",9),act("SB","fold"),act("BB","fold")];
    const result=recommendFromHistory({heroPosition:"CO",hand:"AJs",effectiveStack:100,actions,tableSize:6});
    expect(result.strategySource).toBe("pack:dcfr-6max-100bb-v1");
    expect(result.frequencies.Fold).toBe(45);
  });
  it("labels limped pots as check or isolation raise",()=>{
    installSixMaxPack();
    const actions=[act("UTG","fold"),act("HJ","fold"),act("CO","fold"),act("BTN","fold"),act("SB","limp",1)];
    const result=recommendFromHistory({heroPosition:"BB",hand:"KTo",effectiveStack:100,actions,tableSize:6});
    expect(result.displayFrequencies.map(item=>item.action)).toEqual(["Fold","Check","Iso raise"]);
    expect(result.strategySource).toBe("pack:dcfr-6max-100bb-v1");
  });
  it("falls back to the bundled data when the table size has no pack",()=>{
    installSixMaxPack();
    const mix=lookupStrategy({hand:"AA",position:"UTG",stack:100,scenario:"unopened",tableSize:8});
    expect(mix.source.startsWith("pack:")).toBe(false);
  });
  it("does not collapse a range when the observed action is outside the solved model",()=>{
    installSixMaxPack();
    const range=inferRangeFromPreflop({actions:[act("UTG","limp",1)],seat:0,position:"UTG",stack:100,tableSize:6});
    expect(range.handCount).toBeGreaterThan(10);
  });
  it("ignores packs after a 5-bet, which they do not cover",()=>{
    installSixMaxPack();
    const actions=[act("UTG","open",2.5),act("HJ","fold"),act("CO","3bet",9),act("BTN","fold"),act("SB","fold"),act("BB","fold"),act("UTG","4bet",22),act("CO","5bet",50)];
    expect(lookupStrategy({hand:"AA",position:"UTG",stack:100,scenario:"facing-4bet",tableSize:6,...derivePreflopSpotContext(actions)}).source.startsWith("pack:")).toBe(false);
  });
  it("narrows inferred ranges with the pack for the given table size",()=>{
    installSixMaxPack();
    const actions=[act("UTG","fold"),act("HJ","fold"),act("CO","open",2.5),act("BTN","call",2.5)];
    const withPack=inferRangeFromPreflop({actions,seat:0,position:"BTN",stack:100,tableSize:6});
    const withoutPack=inferRangeFromPreflop({actions,seat:0,position:"BTN",stack:100});
    expect(withPack.text).not.toBe(withoutPack.text);
  });
});
