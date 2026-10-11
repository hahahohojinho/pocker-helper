/** win/tie/loss are shares of samples (a tie is any split); equity counts a tie as 1/(players tied). */
export interface EquityResult { win:number; tie:number; loss:number; equity:number; iterations:number;marginOfError:number;seed:number; }
export type Card={rank:number;suit:string;code:string};
const rankChars="23456789TJQKA";
const suits="cdhs";

export function seededRandom(seed:number){let state=seed>>>0;return ()=>{state+=0x6D2B79F5;let value=state;value=Math.imul(value^(value>>>15),value|1);value^=value+Math.imul(value^(value>>>7),value|61);return ((value^(value>>>14))>>>0)/4294967296;};}

export function parseCard(raw:string):Card|null{
  const code=raw.trim().toUpperCase();
  if(code.length!==2)return null;
  const rank=rankChars.indexOf(code[0]);
  const suit=code[1].toLowerCase();
  return rank<0||!suits.includes(suit)?null:{rank:rank+2,suit,code:`${code[0]}${suit}`};
}

function fiveCardScore(cards:Card[]){
  const counts=new Map<number,number>();cards.forEach(card=>counts.set(card.rank,(counts.get(card.rank)??0)+1));
  const groups=[...counts.entries()].sort((a,b)=>b[1]-a[1]||b[0]-a[0]);
  const flush=cards.every(card=>card.suit===cards[0].suit);
  const unique=[...new Set(cards.map(card=>card.rank))].sort((a,b)=>b-a);
  if(unique[0]===14)unique.push(1);
  let straightHigh=0;for(let i=0;i<=unique.length-5;i++)if(unique[i]-unique[i+4]===4){straightHigh=unique[i];break;}
  const encode=(category:number,values:number[])=>Array.from({length:5},(_,index)=>values[index]??0).reduce((score,value)=>score*15+value,category);
  if(flush&&straightHigh)return encode(8,[straightHigh]);
  if(groups[0][1]===4)return encode(7,[groups[0][0],groups[1][0]]);
  if(groups[0][1]===3&&groups[1]?.[1]===2)return encode(6,[groups[0][0],groups[1][0]]);
  if(flush)return encode(5,cards.map(card=>card.rank).sort((a,b)=>b-a));
  if(straightHigh)return encode(4,[straightHigh]);
  if(groups[0][1]===3)return encode(3,[groups[0][0],...groups.filter(group=>group[1]===1).map(group=>group[0])]);
  if(groups[0][1]===2&&groups[1]?.[1]===2)return encode(2,[Math.max(groups[0][0],groups[1][0]),Math.min(groups[0][0],groups[1][0]),groups.find(group=>group[1]===1)![0]]);
  if(groups[0][1]===2)return encode(1,[groups[0][0],...groups.filter(group=>group[1]===1).map(group=>group[0])]);
  return encode(0,groups.map(group=>group[0]));
}

const SCORE_BASE=15;
const encodeScore=(category:number,values:number[])=>{let score=category;for(let index=0;index<5;index++)score=score*SCORE_BASE+(values[index]??0);return score;};
const SUIT_INDEX:Record<string,number>={c:0,d:1,h:2,s:3};
const suitIndex=(suit:string)=>{const index=SUIT_INDEX[suit];if(index===undefined)throw new Error(`Unknown card suit: ${suit}`);return index;};
const ACE=14;
const WHEEL_ACE=1;

function straightHigh(rankMask:number){
  const mask=rankMask&(1<<ACE)?rankMask|(1<<WHEEL_ACE):rankMask;
  for(let high=ACE;high>=5;high--)if(((mask>>(high-4))&0b11111)===0b11111)return high;
  return 0;
}

function topRanks(rankMask:number,count:number,exclude:number[]=[]){
  const values:number[]=[];
  for(let rank=ACE;rank>=2&&values.length<count;rank--)if(rankMask&(1<<rank)&&!exclude.includes(rank))values.push(rank);
  return values;
}

/**
 * Scores the best five-card hand from 5 to 7 cards with rank counts and bitmasks. Returns exactly the same number as
 * bestHandScoreReference (category first, then base-15 tiebreak ranks) without enumerating 21 combinations.
 */
export function bestHandScore(cards:Card[]){
  if(cards.length<5)return 0;
  const counts=new Array<number>(15).fill(0);const suitMasks=[0,0,0,0];const suitCounts=[0,0,0,0];let rankMask=0;
  for(const card of cards){const suit=suitIndex(card.suit);counts[card.rank]++;rankMask|=1<<card.rank;suitMasks[suit]|=1<<card.rank;suitCounts[suit]++;}
  const flushSuit=suitCounts.findIndex(count=>count>=5);
  if(flushSuit>=0){const high=straightHigh(suitMasks[flushSuit]);if(high)return encodeScore(8,[high]);}
  let quad=0;const trips:number[]=[];const pairs:number[]=[];
  for(let rank=ACE;rank>=2;rank--){if(counts[rank]===4)quad=rank;else if(counts[rank]===3)trips.push(rank);else if(counts[rank]===2)pairs.push(rank);}
  if(quad)return encodeScore(7,[quad,topRanks(rankMask,1,[quad])[0]]);
  if(trips.length&&(trips.length>1||pairs.length))return encodeScore(6,[trips[0],Math.max(trips[1]??0,pairs[0]??0)]);
  if(flushSuit>=0)return encodeScore(5,topRanks(suitMasks[flushSuit],5));
  const straight=straightHigh(rankMask);
  if(straight)return encodeScore(4,[straight]);
  if(trips.length)return encodeScore(3,[trips[0],...topRanks(rankMask,2,[trips[0]])]);
  if(pairs.length>=2)return encodeScore(2,[pairs[0],pairs[1],topRanks(rankMask,1,[pairs[0],pairs[1]])[0]]);
  if(pairs.length)return encodeScore(1,[pairs[0],...topRanks(rankMask,3,[pairs[0]])]);
  return encodeScore(0,topRanks(rankMask,5));
}

/** Original 21-combination evaluator, kept as the test oracle for bestHandScore. */
export function bestHandScoreReference(cards:Card[]){
  let best=0;
  for(let a=0;a<cards.length-4;a++)for(let b=a+1;b<cards.length-3;b++)for(let c=b+1;c<cards.length-2;c++)for(let d=c+1;d<cards.length-1;d++)for(let e=d+1;e<cards.length;e++)best=Math.max(best,fiveCardScore([cards[a],cards[b],cards[c],cards[d],cards[e]]));
  return best;
}

export function calculateEquity(heroCodes:string[],boardCodes:string[],opponents:number,iterations=5000,seed=20260826):EquityResult{
  const known=[...heroCodes,...boardCodes].map(parseCard);
  if(heroCodes.length!==2||known.some(card=>!card))throw new Error("Hero 카드와 보드 카드 형식을 확인하세요.");
  const cards=known as Card[];
  if(new Set(cards.map(card=>card.code)).size!==cards.length)throw new Error("같은 카드를 두 번 사용할 수 없습니다.");
  const fullDeck:Card[]=[];for(const rank of rankChars)for(const suit of suits)fullDeck.push(parseCard(`${rank}${suit}`)!);
  const remaining=fullDeck.filter(card=>!cards.some(knownCard=>knownCard.code===card.code));
  const missingBoard=5-boardCodes.length;
  if(opponents<1||remaining.length<missingBoard+opponents*2)throw new Error("상대 수 또는 카드 입력이 올바르지 않습니다.");
  // A tie splits the pot among everyone holding the best hand, so each sample is worth 1/(tied players).
  let wins=0,ties=0,losses=0,equityUnits=0,squaredUnits=0;const random=seededRandom(seed);
  for(let run=0;run<iterations;run++){
    const deck=[...remaining];
    for(let i=0;i<missingBoard+opponents*2;i++){const j=i+Math.floor(random()*(deck.length-i));[deck[i],deck[j]]=[deck[j],deck[i]];}
    const board=[...cards.slice(2),...deck.slice(0,missingBoard)];
    const heroScore=bestHandScore([...cards.slice(0,2),...board]);
    const opponentScores=Array.from({length:opponents},(_,index)=>bestHandScore([...deck.slice(missingBoard+index*2,missingBoard+index*2+2),...board]));
    const bestOpponent=Math.max(...opponentScores);
    if(heroScore>bestOpponent){wins++;equityUnits++;squaredUnits++;}
    else if(heroScore===bestOpponent){ties++;const share=1/(1+opponentScores.filter(score=>score===heroScore).length);equityUnits+=share;squaredUnits+=share*share;}
    else losses++;
  }
  const percent=(value:number)=>Math.round(value/iterations*1000)/10;
  const mean=equityUnits/iterations;const marginOfError=Math.round(1.96*Math.sqrt(Math.max(0,squaredUnits/iterations-mean*mean)/iterations)*1000)/10;
  return {win:percent(wins),tie:percent(ties),loss:percent(losses),equity:percent(equityUnits),iterations,marginOfError,seed};
}
