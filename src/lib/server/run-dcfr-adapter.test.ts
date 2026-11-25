import { describe, expect, it } from "vitest";
import { isAdapterExecutable, parseAdapterCapabilities } from "./run-dcfr-adapter";

describe("isAdapterExecutable",()=>{
  it.each<[NodeJS.Platform,string,boolean]>([
    ["win32","C:/bin/rangelab-dcfr-adapter.exe",true],
    ["win32","C:/bin/RANGELAB-DCFR-ADAPTER.EXE",true],
    ["win32","C:/bin/rangelab-dcfr-adapter",false],
    ["linux","/opt/bin/rangelab-dcfr-adapter",true],
    ["linux","/opt/bin/rangelab-dcfr-adapter.exe",false],
    ["linux","/opt/bin/RANGELAB-DCFR-ADAPTER",false],
    ["darwin","/opt/bin/rangelab-dcfr-adapter",true],
    ["linux","/opt/bin/sh",false],
  ])("%s %s -> %s",(platform,path,expected)=>{
    expect(isAdapterExecutable(path,platform)).toBe(expected);
  });
});

describe("parseAdapterCapabilities",()=>{
  it("reads the multiway mode and ignores unknown streets",()=>{
    expect(parseAdapterCapabilities('{"json":true,"multiway":{"maxPlayers":3,"streets":["river","preflop"]}}')).toEqual({maxPlayers:3,streets:["river"]});
  });
  it.each(["","not json",'{"json":true}','{"multiway":{"maxPlayers":2,"streets":["river"]}}','{"multiway":{"maxPlayers":3,"streets":[]}}'])("reports no multiway support for %j",raw=>{
    expect(parseAdapterCapabilities(raw)).toBeNull();
  });
});
