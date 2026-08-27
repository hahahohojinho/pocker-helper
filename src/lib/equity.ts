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

export function bestHandScore(cards:Card[]){
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
  let wins=0,ties=0,losses=0;const random=seededRandom(seed);
  for(let run=0;run<iterations;run++){
    const deck=[...remaining];
    for(let i=0;i<missingBoard+opponents*2;i++){const j=i+Math.floor(random()*(deck.length-i));[deck[i],deck[j]]=[deck[j],deck[i]];}
    const board=[...cards.slice(2),...deck.slice(0,missingBoard)];
    const heroScore=bestHandScore([...cards.slice(0,2),...board]);
    const opponentScores=Array.from({length:opponents},(_,index)=>bestHandScore([...deck.slice(missingBoard+index*2,missingBoard+index*2+2),...board]));
    const bestOpponent=Math.max(...opponentScores);
    if(heroScore>bestOpponent)wins++;else if(heroScore===bestOpponent)ties++;else losses++;
  }
  const percent=(value:number)=>Math.round(value/iterations*1000)/10;
  const equityUnits=wins+ties/2;const mean=equityUnits/iterations;const secondMoment=(wins+ties/4)/iterations;const marginOfError=Math.round(1.96*Math.sqrt(Math.max(0,secondMoment-mean*mean)/iterations)*1000)/10;
  return {win:percent(wins),tie:percent(ties),loss:percent(losses),equity:percent(equityUnits),iterations,marginOfError,seed};
}
