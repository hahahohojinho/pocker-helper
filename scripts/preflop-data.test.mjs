import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALL_HANDS, CONTRACT, LEGACY_CONTRACT, createTemplate, main, normalizeRows, parseCsv, validateDataset } from "./preflop-data.mjs";

const metadata={contract:CONTRACT,id:"test-6max-v1",license:"Proprietary - self solved",generatedAt:"2026-08-27"};

describe("preflop data pipeline",()=>{
  it("creates a complete 169-hand authoring template",()=>{
    const csv=createTemplate({positions:["BTN"],stacks:[100],scenarios:["unopened"]});
    const rows=parseCsv(csv);
    expect(rows).toHaveLength(169);
    expect(new Set(rows.map(row=>row.hand))).toEqual(new Set(ALL_HANDS));
  });
  it("creates v2 context and sizing columns",()=>{
    const rows=parseCsv(createTemplate({positions:["BTN"],stacks:[100],scenarios:["open-with-callers"],openerPosition:"CO",callerPositions:["SB"],actionSizes:[2.5,3]}));
    expect(rows).toHaveLength(338);
    expect(rows[0]).toMatchObject({openerposition:"CO",callerpositions:"SB",actionsize:"2.5"});
    expect(rows[169].actionsize).toBe("3");
  });
  it("normalizes CSV aliases and probability frequencies",()=>{
    const rows=normalizeRows(parseCsv("holding,pos,stack_bb,spot,fold,call,raise\nqaS,btn,100,unopened,0.1,0.2,0.7\n"));
    expect(rows[0]).toEqual({hand:"AQs",position:"BTN",stack:100,scenario:"unopened",fold:10,passive:20,aggressive:70});
  });
  it("validates and canonicalizes a complete spot",()=>{
    const report=validateDataset({...metadata,rows:ALL_HANDS.map(hand=>({hand,position:"BTN",stack:100,scenario:"unopened",fold:10,passive:20,aggressive:70}))});
    expect(report).toMatchObject({spots:1,rows:169,dataset:{contract:CONTRACT,id:"test-6max-v1"}});
  });
  it("continues to validate legacy v1 datasets",()=>{
    const report=validateDataset({...metadata,contract:LEGACY_CONTRACT,rows:ALL_HANDS.map(hand=>({hand,position:"BTN",stack:100,scenario:"unopened",fold:10,passive:20,aggressive:70}))});
    expect(report.dataset.contract).toBe(LEGACY_CONTRACT);
  });
  it("reports incomplete and duplicate spots",()=>{
    const rows=ALL_HANDS.slice(1).map(hand=>({hand,position:"BTN",stack:100,scenario:"unopened",fold:10,passive:20,aggressive:70}));
    expect(()=>validateDataset({...metadata,rows})).toThrow("168/169");
    expect(()=>validateDataset({...metadata,rows:[...rows,{...rows[0]}]})).toThrow("duplicate hand");
  });
  it("rejects invalid metadata and frequency totals",()=>{
    const rows=ALL_HANDS.map(hand=>({hand,position:"BTN",stack:100,scenario:"unopened",fold:10,passive:20,aggressive:60}));
    expect(()=>validateDataset({...metadata,license:"",rows})).toThrow("license");
    expect(()=>validateDataset({...metadata,rows})).toThrow("expected 100");
  });
  it("runs the convert and validate CLI pipeline on disk",async()=>{
    const directory=await mkdtemp(join(tmpdir(),"rangelab-preflop-cli-"));
    const input=join(directory,"source.csv"),output=join(directory,"dataset.json");
    try{
      const rows=ALL_HANDS.map(hand=>`${hand},BTN,100,unopened,0.1,0.2,0.7`).join("\n");
      await writeFile(input,`hand,position,stack,scenario,fold,call,raise\n${rows}\n`,"utf8");
      await expect(main(["convert",input,output,"--id","cli-v1","--license","MIT","--generated-at","2026-08-27"])).resolves.toContain("1 spots, 169 rows");
      await expect(main(["validate",output])).resolves.toContain("Valid cli-v1");
      expect(JSON.parse(await readFile(output,"utf8")).contract).toBe(CONTRACT);
    }finally{await rm(directory,{recursive:true,force:true});}
  });
});
