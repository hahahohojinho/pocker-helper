import { describe, expect, it } from "vitest";
import { parseSolverResult } from "../solver-adapter";
import { buildMultiwaySolveRequest } from "../wasm-solver/multiway-request";
import { adapterMultiwayCapability, runMultiwayJsonAdapter } from "./run-dcfr-adapter";

const dcfrAdapterAvailable=Boolean(process.env.DCFR_ADAPTER_PATH);

describe.skipIf(!dcfrAdapterAvailable)("native multiway adapter",()=>{
  it("advertises the 3-player river mode",async()=>{
    expect(await adapterMultiwayCapability()).toEqual({maxPlayers:3,streets:["river","turn"]});
  });
  it("solves Hero facing a bet and call on a 3-way river within the budget",async()=>{
    const request=buildMultiwaySolveRequest({
      board:["Kd","9h","5c","2s","7d"],heroHole:["Ah","Jh"],heroIndex:2,
      players:[{range:"AA,KK,QQ,AKs,AKo,AQs,KQs,JJ,TT,99,AJs,KJs,QJs",stack:30},{range:"AKs,AKo,AQs,AQo,KQs,JJ,TT,99,88,JTs,T9s,98s,A5s",stack:30},{range:"QQ,JJ,AQs,AQo,KQs,KQo,QJs,JTs,T9s,A4s,K9s,AhJh",stack:25}],
      pot:10,history:[{player:0,action:"bet",amount:5},{player:1,action:"call",amount:5}],
      iterations:1000,betPercent:[50],raisePercent:[60],timeBudgetMs:3000,
    });
    const started=Date.now();
    const result=parseSolverResult(await runMultiwayJsonAdapter(request,{threads:4,timeoutMs:20_000}));
    expect(Date.now()-started).toBeLessThan(10_000);
    expect(result.source).toBe("multiway-native");
    expect(result.evSource).toBe("solver");
    expect(result.actions.map(action=>action.action).sort()).toEqual(["call","fold","raise"]);
    expect(result.maxBrGain).toBeLessThan(1);
  },30_000);
});
