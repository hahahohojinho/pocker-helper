import { describe, expect, it } from "vitest";
import { hasRake, loadRakeSetting, NO_RAKE, parseRakeSetting, saveRakeSetting } from "./table-config";

describe("rake setting",()=>{
  it("accepts a percent and cap within limits and treats anything else as no rake",()=>{
    expect(parseRakeSetting({percent:5,capBb:3})).toEqual({percent:5,capBb:3});
    for(const bad of [null,"5",{percent:5},{percent:-1,capBb:3},{percent:11,capBb:3},{percent:5,capBb:101},{percent:Number.NaN,capBb:3},{percent:5,capBb:0}])expect(parseRakeSetting(bad)).toEqual(NO_RAKE);
    expect(hasRake(NO_RAKE)).toBe(false);
    expect(parseRakeSetting({percent:10,capBb:100})).toEqual({percent:10,capBb:100});
    expect(parseRakeSetting({percent:10,capBb:100.5})).toEqual(NO_RAKE);
    expect(parseRakeSetting({percent:5,capBb:0.001})).toEqual(NO_RAKE);
    expect(parseRakeSetting({percent:5,capBb:2.345})).toEqual({percent:5,capBb:2.35});
  });
  it("round-trips through storage and survives broken or missing storage",()=>{
    const store=new Map<string,string>();
    const storage={getItem:(key:string)=>store.get(key)??null,setItem:(key:string,value:string)=>{store.set(key,value);}};
    saveRakeSetting(storage,{percent:4.5,capBb:2});
    expect(loadRakeSetting(storage)).toEqual({percent:4.5,capBb:2});
    store.set("rangelab.rake.v1","{");
    expect(loadRakeSetting(storage)).toEqual(NO_RAKE);
    expect(loadRakeSetting(null)).toEqual(NO_RAKE);
    expect(()=>saveRakeSetting({setItem:()=>{throw new Error("quota");}},{percent:5,capBb:3})).not.toThrow();
  });
});
