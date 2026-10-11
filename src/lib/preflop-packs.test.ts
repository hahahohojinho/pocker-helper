import { afterEach, describe, expect, it, vi } from "vitest";
import { clearPreflopPacks, installPreflopPack, loadPreflopPack, lookupPackStrategy, packStackBuckets, parsePreflopPack } from "./preflop-packs";
import { allStartingHands } from "./strategy-data";

const hands=["22",...allStartingHands.filter(hand=>hand!=="22")];
const mix=(fold:number,passive:number)=>hands.map(()=>[fold,passive]);
const spot=(fields:Record<string,unknown>)=>({callerPositions:[],limperPositions:[],reach:0.1,unreached:0,mix:mix(500,300),...fields});

function pack(overrides:Record<string,unknown>={}){
  return {
    contract:"rangelab.preflop_pack.v1",id:"dcfr-6max-100bb-v1",license:"MIT",generatedAt:"2026-10-11",tableSize:6,stack:100,
    provenance:{generator:"rangelab-preflop",revision:"abc",iterations:100,seed:42,model:"test"},hands,
    spots:[
      spot({position:"UTG",scenario:"unopened",mix:mix(800,0)}),
      spot({position:"BTN",scenario:"single-open",openerPosition:"CO",aggressorPosition:"CO",actionSize:"2.5",mix:mix(400,450)}),
      spot({position:"CO",scenario:"facing-3bet",openerPosition:"CO",aggressorPosition:"BTN",actionSize:"9",mix:mix(500,350)}),
      spot({position:"CO",scenario:"facing-3bet",openerPosition:"CO",aggressorPosition:"BTN",actionSize:"100",mix:mix(900,100)}),
      spot({position:"BB",scenario:"limped",limperPositions:["SB"],mix:mix(0,700)}),
    ],
    ...overrides,
  };
}

afterEach(()=>{clearPreflopPacks();vi.restoreAllMocks();});

describe("preflop pack validation",()=>{
  it("accepts a well-formed pack",()=>{
    const parsed=parsePreflopPack(JSON.stringify(pack()));
    expect(parsed.spots).toHaveLength(5);
    expect(parsed.spots[1].actionSize).toBe(2.5);
  });
  it("rejects packs with the wrong shape or impossible values",()=>{
    expect(()=>parsePreflopPack(JSON.stringify(pack({contract:"other"})))).toThrow(/contract/);
    expect(()=>parsePreflopPack(JSON.stringify(pack({tableSize:7})))).toThrow(/tableSize/);
    expect(()=>parsePreflopPack(JSON.stringify(pack({hands:hands.slice(1)})))).toThrow(/169/);
    expect(()=>parsePreflopPack(JSON.stringify(pack({spots:[spot({position:"UTG+1",scenario:"unopened"})]})))).toThrow(/position/);
    expect(()=>parsePreflopPack(JSON.stringify(pack({spots:[spot({position:"UTG",scenario:"unopened",mix:mix(800,300)})]})))).toThrow(/mix/);
    expect(()=>parsePreflopPack(JSON.stringify(pack({spots:[spot({position:"UTG",scenario:"weird"})]})))).toThrow(/scenario/);
    expect(()=>parsePreflopPack("{")).toThrow(/JSON/);
    const duplicate=spot({position:"UTG",scenario:"unopened"});
    expect(()=>parsePreflopPack(JSON.stringify(pack({spots:[duplicate,duplicate]})))).toThrow(/duplicate/);
    expect(()=>parsePreflopPack(JSON.stringify(pack({spots:[spot({position:"UTG",scenario:"unopened",limperPositions:Array(9).fill("SB")})]})))).toThrow(/limperPositions/);
  });
});

describe("pack lookup",()=>{
  it("returns the exact spot's mix as percentages for the hand",()=>{
    installPreflopPack(parsePreflopPack(JSON.stringify(pack())));
    expect(lookupPackStrategy({tableSize:6,stack:100,hand:"AKo",position:"BTN",scenario:"single-open",openerPosition:"CO",aggressorPosition:"CO",callerPositions:[],actionSize:2.5}))
      .toEqual({fold:40,passive:45,aggressive:15,source:"pack:dcfr-6max-100bb-v1"});
  });
  it("picks the nearest bet size among otherwise matching spots",()=>{
    installPreflopPack(parsePreflopPack(JSON.stringify(pack())));
    const facing=(size:number)=>lookupPackStrategy({tableSize:6,stack:100,hand:"AA",position:"CO",scenario:"facing-3bet",openerPosition:"CO",aggressorPosition:"BTN",callerPositions:[],actionSize:size});
    expect(facing(10)?.fold).toBe(50);
    expect(facing(80)?.fold).toBe(90);
  });
  it("uses the nearest installed stack for the same table size only",()=>{
    installPreflopPack(parsePreflopPack(JSON.stringify(pack())));
    installPreflopPack(parsePreflopPack(JSON.stringify(pack({id:"dcfr-6max-20bb-v1",stack:20,spots:[spot({position:"UTG",scenario:"unopened",mix:mix(100,0)})]}))));
    const utg=(stack:number,tableSize:6|8)=>lookupPackStrategy({tableSize,stack,hand:"72o",position:"UTG",scenario:"unopened",callerPositions:[]});
    expect(utg(85,6)?.fold).toBe(80);
    expect(utg(25,6)?.fold).toBe(10);
    expect(utg(100,8)).toBeNull();
  });
  it("refuses bet sizes and stacks too far from the solved ones",()=>{
    installPreflopPack(parsePreflopPack(JSON.stringify(pack())));
    expect(lookupPackStrategy({tableSize:6,stack:100,hand:"AA",position:"BTN",scenario:"single-open",openerPosition:"CO",aggressorPosition:"CO",callerPositions:[],actionSize:8})).toBeNull();
    expect(lookupPackStrategy({tableSize:6,stack:300,hand:"72o",position:"UTG",scenario:"unopened",callerPositions:[]})).toBeNull();
  });
  it("breaks equal stack distances toward the smaller stack, like the loader",()=>{
    installPreflopPack(parsePreflopPack(JSON.stringify(pack())));
    installPreflopPack(parsePreflopPack(JSON.stringify(pack({id:"dcfr-6max-60bb-v1",stack:60,spots:[spot({position:"UTG",scenario:"unopened",mix:mix(100,0)})]}))));
    expect(lookupPackStrategy({tableSize:6,stack:80,hand:"72o",position:"UTG",scenario:"unopened",callerPositions:[]})?.fold).toBe(10);
  });
  it("requires callers and limpers to match exactly",()=>{
    installPreflopPack(parsePreflopPack(JSON.stringify(pack())));
    expect(lookupPackStrategy({tableSize:6,stack:100,hand:"AA",position:"BTN",scenario:"single-open",openerPosition:"CO",aggressorPosition:"CO",callerPositions:["HJ"],actionSize:2.5})).toBeNull();
    expect(lookupPackStrategy({tableSize:6,stack:100,hand:"AA",position:"BB",scenario:"limped",callerPositions:[],limperPositions:["SB"]})?.passive).toBe(70);
  });
});

describe("pack loading",()=>{
  it("fetches the nearest stack bucket and installs it once",async()=>{
    const fetchImpl=vi.fn(async(url:string)=>url.endsWith("6max-100bb.json")?new Response(JSON.stringify(pack())):new Response("missing",{status:404})) as unknown as typeof fetch&{mock:{calls:unknown[]}};
    expect(packStackBuckets).toContain(100);
    expect((await loadPreflopPack(6,90,fetchImpl))?.id).toBe("dcfr-6max-100bb-v1");
    await loadPreflopPack(6,110,fetchImpl);
    expect(fetchImpl.mock.calls).toHaveLength(1);
  });
  it("skips a non-JSON page and a pack for the wrong table or stack",async()=>{
    const fetchImpl=vi.fn(async(url:string)=>url.endsWith("6max-100bb.json")?new Response("<html>",{headers:{"content-type":"text/html"}})
      :url.endsWith("6max-60bb.json")?new Response(JSON.stringify(pack()),{headers:{"content-type":"application/json"}}):new Response("missing",{status:404})) as unknown as typeof fetch;
    expect(await loadPreflopPack(6,100,fetchImpl)).toBeNull();
  });
  it("falls back to the next nearest bucket and reports absence as null",async()=>{
    const fetchImpl=vi.fn(async(url:string)=>url.endsWith("6max-100bb.json")?new Response(JSON.stringify(pack())):new Response("missing",{status:404})) as unknown as typeof fetch&{mock:{calls:unknown[]}};
    expect((await loadPreflopPack(6,140,fetchImpl))?.stack).toBe(100);
    expect(await loadPreflopPack(8,100,vi.fn(async()=>new Response("missing",{status:404})) as unknown as typeof fetch)).toBeNull();
  });
});
