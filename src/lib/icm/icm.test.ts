import { describe, expect, it } from "vitest";
import { dollarEvChange, icmEquity, MAX_ICM_PLAYERS, parsePayouts } from "./icm";

const sum=(values:number[])=>values.reduce((total,value)=>total+value,0);

describe("icmEquity",()=>{
  it("splits prizes evenly between equal stacks",()=>{
    for(const equity of icmEquity([1000,1000,1000],[50,30,20]))expect(equity).toBeCloseTo(100/3,10);
  });
  it("matches the Malmuth-Harville closed form for three players",()=>{
    // Stacks 5000/3000/2000, prizes 50/30/20. P(A first)=0.5; A second: B first (0.3) then A wins 5/7 of the rest,
    // C first (0.2) then A wins 5/8. A = 0.5*50 + (0.3*5/7 + 0.2*5/8)*30 + (0.3*2/7 + 0.2*3/8)*20.
    const a=0.5*50+(0.3*5/7+0.2*5/8)*30+(0.3*2/7+0.2*3/8)*20;
    const equity=icmEquity([5000,3000,2000],[50,30,20]);
    expect(equity[0]).toBeCloseTo(a,10);
    expect(sum(equity)).toBeCloseTo(100,10);
    expect(equity[0]).toBeLessThan(50);
  });
  it("gives a lone survivor first prize and busted players the lowest places",()=>{
    expect(icmEquity([0,5000,0],[50,30,20])).toEqual([25,50,25]);
    expect(icmEquity([3000,0],[70,30])).toEqual([70,30]);
  });
  it("conserves the prize pool with more players than paid places",()=>{
    const equity=icmEquity([100,200,300,400,500,600],[60,40]);
    expect(sum(equity)).toBeCloseTo(100,10);
    expect(equity[5]).toBeGreaterThan(equity[0]);
  });
  it("rejects invalid input and tables above the exact limit",()=>{
    expect(()=>icmEquity([],[1])).toThrow();
    expect(()=>icmEquity([1,-1],[1])).toThrow();
    expect(()=>icmEquity([1,1],[Number.NaN])).toThrow();
    expect(()=>icmEquity(Array(MAX_ICM_PLAYERS+1).fill(1),[1])).toThrow();
  });
});

describe("dollarEvChange",()=>{
  it("shows a chip-neutral flip losing prize equity",()=>{
    // Bubble-like spot: doubling or busting is chip EV neutral, but ICM makes it a loss.
    const change=dollarEvChange({stacksBefore:[5000,3000,2000],payouts:[50,30,20],heroIndex:2,outcomes:[{probability:0.5,stacksAfter:[5000,1000,4000]},{probability:0.5,stacksAfter:[5000,5000,0]}]});
    expect(change).toBeLessThan(0);
  });
  it("requires probabilities that sum to one",()=>{
    expect(()=>dollarEvChange({stacksBefore:[1,1],payouts:[1],heroIndex:0,outcomes:[{probability:0.4,stacksAfter:[2,0]}]})).toThrow();
  });
});

describe("parsePayouts",()=>{
  it("reads comma or space separated prizes and percentages",()=>{
    expect(parsePayouts("50, 30, 20")).toEqual([50,30,20]);
    expect(parsePayouts("50% 30% 20%")).toEqual([50,30,20]);
    expect(parsePayouts("abc")).toBeNull();
    expect(parsePayouts("0,0")).toBeNull();
    expect(parsePayouts("")).toBeNull();
  });
});
