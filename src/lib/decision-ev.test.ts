import { describe, expect, it } from "vitest";
import { defaultFoldEquity, estimateActionEvs } from "./decision-ev";
import { callingRange, estimateEquityWhenCalled } from "./called-equity";
import { parseWeightedRange } from "./range-equity";
import { calculateRangeEquity } from "./range-equity";

const evOf=(results:ReturnType<typeof estimateActionEvs>,action:string)=>results.find(item=>item.action===action)?.ev;

describe("model action EV",()=>{
  it("defaults fold equity to the bettor's break-even frequency",()=>{
    const results=estimateActionEvs({equity:50,pot:10,toCall:0,betSize:5});
    // fold 1/3 of the time for the pot, otherwise 50% of a 20 pot for a 5 risk.
    expect(evOf(results,"bet")).toBeCloseTo(10/3+2/3*(0.5*20-5),2);
    expect(results.find(item=>item.action==="bet")!.assumption).toContain("33%");
  });
  it("makes a pure bluff break even at the default fold equity",()=>{
    expect(evOf(estimateActionEvs({equity:30,equityWhenCalled:0,pot:10,toCall:0,betSize:7}),"bet")).toBeCloseTo(0,2);
  });
  it("prefers checking when the calling range crushes a medium hand",()=>{
    const results=estimateActionEvs({equity:30,equityWhenCalled:20,pot:10,toCall:0,betSize:5});
    expect(evOf(results,"check")!).toBeGreaterThan(evOf(results,"bet")!);
  });
  it("lowers bet EV as equity when called falls",()=>{
    const evs=[80,60,40,20].map(value=>evOf(estimateActionEvs({equity:60,equityWhenCalled:value,pot:10,toCall:0,betSize:5}),"bet")!);
    expect(evs).toEqual([...evs].sort((a,b)=>b-a));
  });
  it("prices a raise from the street total, the hero's committed chips, and the villain's call",()=>{
    // Villain bet 5 into 10 (pot now 15); hero raises to 15 total, villain must add 10 more.
    const results=estimateActionEvs({equity:50,pot:15,toCall:5,heroCommitted:0,betSize:15});
    const foldEquity=15/30;
    expect(evOf(results,"raise")).toBeCloseTo(foldEquity*15+(1-foldEquity)*(0.5*40-15),2);
    expect(evOf(results,"call")).toBeCloseTo(0.5*20-5,2);
  });
  it("counts chips the hero already committed on this street",()=>{
    // Hero bet 5, villain raised to 15 (pot 30); hero re-raises to 40 total, adding 35.
    const results=estimateActionEvs({equity:50,pot:30,toCall:10,heroCommitted:5,betSize:40});
    const foldEquity=35/65;
    expect(evOf(results,"raise")).toBeCloseTo(foldEquity*30+(1-foldEquity)*(0.5*(30+35+25)-35),2);
  });
  it("omits an aggressive action whose size does not exceed the current bet",()=>{
    expect(estimateActionEvs({equity:50,pot:15,toCall:5,betSize:5}).some(item=>item.action==="raise")).toBe(false);
    expect(estimateActionEvs({equity:50,pot:10,toCall:0,betSize:0}).some(item=>item.action==="bet")).toBe(false);
  });
  it("caps an over-stack bet at what the opponent can call",()=>{
    // Villain has only 20 behind, so a 100 shove plays like a 20 bet.
    const capped=estimateActionEvs({equity:50,pot:10,toCall:0,betSize:100,maxCommitment:20});
    expect(capped).toEqual(estimateActionEvs({equity:50,pot:10,toCall:0,betSize:20}));
    expect(defaultFoldEquity({pot:10,toCall:0,betSize:100,maxCommitment:20})).toBeCloseTo(20/30,5);
  });
  it("limits a call to the hero's stack and returns the uncalled excess",()=>{
    // Pot 40 includes a 30 bet; hero has only 10 behind, so 20 of the bet is returned.
    const results=estimateActionEvs({equity:50,pot:40,toCall:30,betSize:0,maxCommitment:10});
    expect(evOf(results,"call")).toBeCloseTo(0.5*(40-20+10)-10,2);
  });
  it("splits the break-even fold rate across multiway opponents",()=>{
    const results=estimateActionEvs({equity:50,pot:10,toCall:0,betSize:5,opponents:2});
    const bet=results.find(item=>item.action==="bet")!;
    expect(bet.assumption).toContain("멀티웨이 2명");
    expect(bet.assumption).toContain("전원 Fold 33%");
    // Each folds sqrt(1/3); one caller makes a 20 pot, two make 25.
    const fold=Math.sqrt(1/3),one=2*fold*(1-fold),two=(1-fold)**2;
    expect(bet.ev).toBeCloseTo(10/3+one*(0.5*20-5)+two*(0.5*25-5),2);
  });
  it("prices caller subsets with their own equity",()=>{
    const calledEquities={byKey:new Map([["0",50],["1",40],["0,1",30]]),everyone:null};
    const bet=estimateActionEvs({equity:45,pot:10,toCall:0,betSize:5,foldEquities:[0.5,0.6],calledEquities}).find(item=>item.action==="bet")!;
    expect(bet.ev).toBeCloseTo(5.6,2);
    expect(bet.assumption).toContain("콜 조합별 Equity");
  });
  it("gives an all-in opponent no fold share",()=>{
    const bet=estimateActionEvs({equity:50,pot:10,toCall:0,betSize:5,foldable:[true,false],callCaps:[100,0]}).find(item=>item.action==="bet")!;
    expect(bet.assumption).toContain("전원 Fold 0%");
  });
  it("keeps the heads-up result for every single-opponent input",()=>{
    const cases=[{},{foldEquity:0.2},{equityWhenCalled:35},{foldEquity:0.4,equityWhenCalled:30}];
    for(const extra of cases){
      const input={equity:50,pot:10,toCall:0,betSize:5,...extra};
      const fold=extra.foldEquity??1/3,called=(extra.equityWhenCalled??50)/100;
      expect(evOf(estimateActionEvs(input),"bet")).toBeCloseTo(fold*10+(1-fold)*(called*20-5),2);
      expect(estimateActionEvs({...input,opponents:1,foldable:[true]})).toEqual(estimateActionEvs(input));
    }
  });
  it("gives a single all-in opponent no fold and treats no opponents as one",()=>{
    const allIn=estimateActionEvs({equity:50,pot:10,toCall:0,betSize:5,foldable:[false],callCaps:[0]}).find(item=>item.action==="bet")!;
    expect(allIn.assumption).toContain("Fold 0%");
    expect(estimateActionEvs({equity:50,pot:10,toCall:0,betSize:5,opponents:0,foldable:[]})).toEqual(estimateActionEvs({equity:50,pot:10,toCall:0,betSize:5}));
  });
  it("notes players behind a call",()=>{
    const call=estimateActionEvs({equity:50,pot:15,toCall:5,betSize:0,playersBehind:2}).find(item=>item.action==="call")!;
    expect(call.assumption).toContain("뒤 2명 오버콜/스퀴즈 미반영");
  });
  it("honors an explicit fold equity and labels every value as a model",()=>{
    const results=estimateActionEvs({equity:50,pot:10,toCall:0,betSize:5,foldEquity:0});
    expect(evOf(results,"bet")).toBeCloseTo(0.5*20-5,2);
    expect(results.every(item=>item.assumption.startsWith("MODEL"))).toBe(true);
  });
});

describe("default fold equity",()=>{
  it("matches the bettor's break-even bluff frequency",()=>{
    expect(defaultFoldEquity({pot:10,toCall:0,betSize:5})).toBeCloseTo(1/3,5);
    expect(defaultFoldEquity({pot:15,toCall:5,heroCommitted:0,betSize:15})).toBeCloseTo(0.5,5);
    expect(defaultFoldEquity({pot:10,toCall:0,betSize:0})).toBe(0);
  });
});

describe("equity when called",()=>{
  it("is lower than raw equity for a medium pair against a range that calls with stronger hands",()=>{
    const range="AA,KK,QQ,JJ,TT,99,88,77,66,55,44,33,22,AKs,AQs,AJs,KQs,QJs,JTs,T9s,98s,87s,76s,AKo,AQo,KQo,QJo,JTo";
    const hero=["8c","8d"],board=["Ks","7h","2c"];
    const raw=calculateRangeEquity(hero,board,[range],4000).equity;
    const called=estimateEquityWhenCalled(hero,board,[range],1/3,4000);
    expect(called).toBeLessThan(raw-5);
  });
  it("keeps the whole range when nothing folds and rejects an invalid fold share",()=>{
    const raw=calculateRangeEquity(["8c","8d"],["Ks","7h","2c"],["AA,72o"],2000).equity;
    expect(estimateEquityWhenCalled(["8c","8d"],["Ks","7h","2c"],["AA,72o"],0,2000)).toBeCloseTo(raw,5);
    expect(()=>estimateEquityWhenCalled(["8c","8d"],["Ks","7h","2c"],["AA"],1,2000)).toThrow();
  });
  it("returns null when the board is too short to rank a calling range",()=>{
    expect(estimateEquityWhenCalled(["8c","8d"],[],["AA,KK"],0.3,500)).toBeNull();
  });
  it("trims tied combos proportionally instead of by suit order",()=>{
    const combos=parseWeightedRange(callingRange("QJo",["Ks","7h","2c"],0.5));
    expect(combos).toHaveLength(12);
    expect(new Set(combos.map(combo=>combo.weight))).toEqual(new Set([1]));
  });
  it("keeps the strongest combos when the kept weight is tiny",()=>{
    const kept=parseWeightedRange(callingRange("AA:0.0000001,Q3o:0.0000001",["Ks","7h","2c"],0.9));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every(combo=>combo.cards.every(card=>card[0]==="A"))).toBe(true);
  });
  it("drops the weakest continuations first",()=>{
    // QJo is the weaker 12 of 18 combos on this board, so folding two thirds leaves only AA.
    const called=estimateEquityWhenCalled(["8c","8d"],["Ks","7h","2c"],["AA:1,QJo:1"],2/3,2000);
    const versusAces=calculateRangeEquity(["8c","8d"],["Ks","7h","2c"],["AA"],2000).equity;
    expect(Math.abs(called!-versusAces)).toBeLessThan(3);
  });
});
