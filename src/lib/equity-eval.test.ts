import { describe, expect, it } from "vitest";
import { bestHandScore, bestHandScoreReference, parseCard, seededRandom, type Card } from "./equity";
import { calculateRangeEquity } from "./range-equity";

const deck:Card[]=[];
for(const rank of "23456789TJQKA")for(const suit of "cdhs")deck.push(parseCard(`${rank}${suit}`)!);
const cards=(codes:string)=>codes.split(" ").map(code=>parseCard(code)!);

function randomHand(random:()=>number,size:number){
  const shuffled=[...deck];
  for(let index=0;index<size;index++){const swap=index+Math.floor(random()*(deck.length-index));[shuffled[index],shuffled[swap]]=[shuffled[swap],shuffled[index]];}
  return shuffled.slice(0,size);
}

describe("fast hand evaluator",()=>{
  it("matches the 21-combination reference on random 5, 6, and 7 card hands",()=>{
    const random=seededRandom(11);
    for(let index=0;index<20_000;index++){
      const hand=randomHand(random,5+index%3);
      expect(bestHandScore(hand)).toBe(bestHandScoreReference(hand));
    }
  });
  it.each([
    ["wheel straight","Ah 2c 3d 4s 5h Kd Kc"],
    ["royal flush over a lower flush card","9h Th Jh Qh Kh Ah 2h"],
    ["steel wheel","2h 3h 4h 5h Ah 6c 7d"],
    ["two trips make a full house","Ks Kd Kh Qs Qd Qh 2c"],
    ["three pairs keep the best kicker","As Ad Ks Kd Qs Qd Jc"],
    ["quads with a trips kicker","7s 7d 7h 7c Ks Kd Kh"],
    ["six-card flush","2h 4h 6h 8h Th Qh 3c"],
    ["broadway over a lower straight","As Kd Qh Jc Tc 9d 8s"],
    ["flush beats a straight on the same board","9h 8h 7h 6c 5h 2h Kd"],
  ])("handles %s",(_label,codes)=>{
    const hand=cards(codes);
    expect(bestHandScore(hand)).toBe(bestHandScoreReference(hand));
  });
  it("rejects a card with an unnormalized suit instead of misreading a flush",()=>{
    expect(()=>bestHandScore([...cards("As Ks Qs Js"),{rank:10,suit:"S",code:"TS"}])).toThrow("suit");
  });
  it("returns 0 for fewer than five cards like the reference",()=>{
    expect(bestHandScore(cards("As Ks Qs Js"))).toBe(0);
  });
});

describe("range equity performance",()=>{
  it("runs a 5,000-iteration four-way range simulation quickly",()=>{
    const wide="22,33,44,55,66,77,88,99,TT,JJ,QQ,KK,AA,AKs,AQs,AJs,ATs,KQs,KJs,QJs,JTs,T9s,98s,AKo,AQo,KQo";
    const start=performance.now();
    const result=calculateRangeEquity(["As","Qh"],["Js","7d","2c"],[wide,wide,wide,wide],5000);
    expect(performance.now()-start).toBeLessThan(500);
    expect(result.iterations).toBe(5000);
  });
  it("still samples only combos that avoid other opponents' cards",()=>{
    // AhAs collides with the first opponent's AhAd, so the second opponent must always hold KsKh.
    const constrained=calculateRangeEquity(["Kc","Kd"],["2s","7h","9c"],["AhAd","AhAs:1,KsKh:1"],3000);
    const direct=calculateRangeEquity(["Kc","Kd"],["2s","7h","9c"],["AhAd","KsKh"],3000);
    expect(constrained.iterations).toBe(3000);
    expect(Math.abs(constrained.equity-direct.equity)).toBeLessThan(3);
  });
});
