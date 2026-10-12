import { describe, expect, it } from "vitest";
import { isAdapterExecutable } from "./run-dcfr-adapter";

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
