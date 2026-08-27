import { bestHandScore, Card, EquityResult, parseCard, seededRandom } from "./equity";

export interface WeightedCombo { cards:[string,string];weight:number; }
export interface RangeEquityResult extends EquityResult { mode:"weighted-range";availableCombos:number[]; }
const ranks="23456789TJQKA";
const suits="cdhs";

function canonicalCombo(first:string,second:string){return [first,second].sort().join("");}

export function parseWeightedRange(text:string):WeightedCombo[]{
  const merged=new Map<string,WeightedCombo>();
  for(const rawToken of text.split(",")){
    const token=rawToken.trim();if(!token)continue;
    const separator=token.lastIndexOf(":");
    const notation=(separator>=0?token.slice(0,separator):token).trim();
    const weight=separator>=0?Number(token.slice(separator+1)):1;
    if(!Number.isFinite(weight)||weight<=0||weight>1)throw new Error(`${token}: 가중치는 0 초과 1 이하여야 합니다.`);
    const exact=notation.match(/^([2-9TJQKA][cdhs])([2-9TJQKA][cdhs])$/i);
    const generated:[string,string][]=[];
    if(exact){
      const first=parseCard(exact[1]);const second=parseCard(exact[2]);
      if(!first||!second||first.code===second.code)throw new Error(`${token}: 유효하지 않은 카드 콤보입니다.`);
      generated.push([first.code,second.code]);
    }else{
      const generic=notation.match(/^([2-9TJQKA])([2-9TJQKA])([so]?)$/i);
      if(!generic)throw new Error(`${token}: 지원하지 않는 레인지 표기입니다.`);
      const first=generic[1].toUpperCase(),second=generic[2].toUpperCase(),kind=generic[3].toLowerCase();
      if(first===second&&kind)throw new Error(`${token}: 페어에는 s/o를 붙일 수 없습니다.`);
      if(first===second){for(let i=0;i<suits.length;i++)for(let j=i+1;j<suits.length;j++)generated.push([`${first}${suits[i]}`,`${second}${suits[j]}`]);}
      else if(kind==="s"){for(const suit of suits)generated.push([`${first}${suit}`,`${second}${suit}`]);}
      else if(kind==="o"){for(const firstSuit of suits)for(const secondSuit of suits)if(firstSuit!==secondSuit)generated.push([`${first}${firstSuit}`,`${second}${secondSuit}`]);}
      else{for(const firstSuit of suits)for(const secondSuit of suits)generated.push([`${first}${firstSuit}`,`${second}${secondSuit}`]);}
    }
    for(const cards of generated){const key=canonicalCombo(...cards);const previous=merged.get(key);merged.set(key,{cards,weight:(previous?.weight??0)+weight});}
  }
  if(!merged.size)throw new Error("상대 레인지가 비어 있습니다.");
  return [...merged.values()];
}

function sampleCombo(combos:WeightedCombo[],blocked:Set<string>,random:()=>number){
  const available=combos.filter(combo=>combo.cards.every(card=>!blocked.has(card)));
  const total=available.reduce((sum,combo)=>sum+combo.weight,0);
  if(total<=0)return null;
  let target=random()*total;
  for(const combo of available){target-=combo.weight;if(target<=0)return combo;}
  return available.at(-1)??null;
}

export function calculateRangeEquity(heroCodes:string[],boardCodes:string[],rangeTexts:string[],iterations=5000,seed=20260826):RangeEquityResult{
  const known=[...heroCodes,...boardCodes].map(parseCard);
  if(heroCodes.length!==2||known.some(card=>!card))throw new Error("Hero 카드와 보드 카드 형식을 확인하세요.");
  const cards=known as Card[];const knownCodes=new Set(cards.map(card=>card.code));
  if(knownCodes.size!==cards.length)throw new Error("같은 카드를 두 번 사용할 수 없습니다.");
  if(rangeTexts.length<1)throw new Error("상대 레인지가 하나 이상 필요합니다.");
  const ranges=rangeTexts.map(parseWeightedRange);
  const filteredCounts=ranges.map(range=>range.filter(combo=>combo.cards.every(card=>!knownCodes.has(card))).length);
  if(filteredCounts.some(count=>count===0))throw new Error("공개 카드와 충돌하지 않는 상대 콤보가 없습니다.");
  const fullDeck:Card[]=[];for(const rank of ranks)for(const suit of suits)fullDeck.push(parseCard(`${rank}${suit}`)!);
  const missingBoard=5-boardCodes.length;let wins=0,ties=0,losses=0,completed=0;const random=seededRandom(seed);
  for(let run=0;run<iterations;run++){
    const blocked=new Set(knownCodes);const opponents:Card[][]=[];let valid=true;
    for(const range of ranges){const combo=sampleCombo(range,blocked,random);if(!combo){valid=false;break;}combo.cards.forEach(card=>blocked.add(card));opponents.push(combo.cards.map(card=>parseCard(card)!));}
    if(!valid)continue;
    const deck=fullDeck.filter(card=>!blocked.has(card.code));
    for(let i=0;i<missingBoard;i++){const j=i+Math.floor(random()*(deck.length-i));[deck[i],deck[j]]=[deck[j],deck[i]];}
    const board=[...cards.slice(2),...deck.slice(0,missingBoard)];const heroScore=bestHandScore([...cards.slice(0,2),...board]);const opponentScores=opponents.map(hand=>bestHandScore([...hand,...board]));const bestOpponent=Math.max(...opponentScores);
    if(heroScore>bestOpponent)wins++;else if(heroScore===bestOpponent)ties++;else losses++;completed++;
  }
  if(!completed)throw new Error("서로 충돌하지 않는 상대 콤보를 샘플링할 수 없습니다.");
  const percent=(value:number)=>Math.round(value/completed*1000)/10;
  const equityUnits=wins+ties/2;const mean=equityUnits/completed;const secondMoment=(wins+ties/4)/completed;const marginOfError=Math.round(1.96*Math.sqrt(Math.max(0,secondMoment-mean*mean)/completed)*1000)/10;
  return {win:percent(wins),tie:percent(ties),loss:percent(losses),equity:percent(equityUnits),iterations:completed,marginOfError,seed,mode:"weighted-range",availableCombos:filteredCounts};
}
