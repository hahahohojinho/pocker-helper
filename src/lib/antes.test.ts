import { describe, expect, it } from "vitest";
import { NO_ANTE, postAntes } from "./antes";
import { deriveBettingState, bettingAmounts } from "./preflop-machine";
import type { Position } from "./preflop";
import { loadAnteSetting, parseAnteSetting, saveAnteSetting } from "./table-config";

const six:Position[]=["BTN","SB","BB","UTG","HJ","CO"];

describe("postAntes",()=>{
  it("takes a seat ante from every seat as dead money",()=>{
    const posted=postAntes([100,100,100,100,100,40],six,{kind:"seat",amount:0.12});
    expect(posted.playStacks).toEqual([99.88,99.88,99.88,99.88,99.88,39.88]);
    expect(posted.deadMoney).toBe(0.72);
    expect(posted.shortSeats).toEqual([]);
  });
  it("takes a big blind ante from the big blind only",()=>{
    const posted=postAntes(Array(6).fill(50),six,{kind:"bb",amount:1});
    expect(posted.posted).toEqual([0,0,1,0,0,0]);
    expect(posted.playStacks[2]).toBe(49);
    expect(posted.deadMoney).toBe(1);
  });
  it("flags seats that cannot cover their ante and blind",()=>{
    expect(postAntes([100,0.6,1.1,100,0.1,100],six,{kind:"seat",amount:0.2}).shortSeats).toEqual([1,2,4]);
  });
  it("changes nothing without an ante",()=>{
    expect(postAntes([100,90],["SB","BB"],NO_ANTE)).toEqual({playStacks:[100,90],posted:[0,0],deadMoney:0,shortSeats:[]});
  });
});

describe("dead money in the betting state",()=>{
  it("grows the pot without changing the bet to call or the minimum raise",()=>{
    const plain=bettingAmounts([],six,3,100);
    const withAnte=bettingAmounts([],six,3,100,0.6);
    expect(withAnte.pot).toBeCloseTo(plain.pot+0.6,10);
    expect([withAnte.toCall,withAnte.minimumRaiseTo,withAnte.currentBet]).toEqual([plain.toCall,plain.minimumRaiseTo,plain.currentBet]);
    expect(deriveBettingState([],six,100,0.6).pot).toBeCloseTo(2.1,10);
  });
});

describe("ante setting",()=>{
  it("accepts a seat or big blind ante within limits and rounds to cents",()=>{
    expect(parseAnteSetting({kind:"seat",amount:0.125})).toEqual({kind:"seat",amount:0.13});
    expect(parseAnteSetting({kind:"bb",amount:1})).toEqual({kind:"bb",amount:1});
    for(const bad of [null,{kind:"other",amount:1},{kind:"seat",amount:-1},{kind:"seat",amount:11},{kind:"seat",amount:0.001},{kind:"seat",amount:Number.NaN}])expect(parseAnteSetting(bad)).toEqual(NO_ANTE);
  });
  it("round-trips through storage",()=>{
    const store=new Map<string,string>();
    const storage={getItem:(key:string)=>store.get(key)??null,setItem:(key:string,value:string)=>{store.set(key,value);}};
    saveAnteSetting(storage,{kind:"bb",amount:1});
    expect(loadAnteSetting(storage)).toEqual({kind:"bb",amount:1});
    store.set("rangelab.ante.v1","[");
    expect(loadAnteSetting(storage)).toEqual(NO_ANTE);
  });
});
