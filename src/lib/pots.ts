export interface PotLayer { amount:number; cap:number; eligibleSeats:number[]; contributorSeats:number[]; }

export function calculatePotLayers(contributions:ReadonlyMap<number,number>,foldedSeats:ReadonlySet<number>):PotLayer[]{
  const positive=[...contributions.entries()].filter(([,amount])=>amount>0);
  const levels=[...new Set(positive.map(([,amount])=>amount))].sort((a,b)=>a-b);
  const pots:PotLayer[]=[];
  let previous=0;
  for(const cap of levels){
    const contributors=positive.filter(([,amount])=>amount>=cap).map(([seat])=>seat);
    const amount=(cap-previous)*contributors.length;
    if(amount>0)pots.push({amount,cap,contributorSeats:contributors,eligibleSeats:contributors.filter(seat=>!foldedSeats.has(seat))});
    previous=cap;
  }
  return pots;
}

export function totalPot(pots:PotLayer[]){return pots.reduce((sum,pot)=>sum+pot.amount,0);}

export function calculatePokerPots(contributions:ReadonlyMap<number,number>,foldedSeats:ReadonlySet<number>,allInSeats:ReadonlySet<number>):PotLayer[]{
  const positive=[...contributions.entries()].filter(([,amount])=>amount>0);
  if(!positive.length)return [];
  const maximum=Math.max(...positive.map(([,amount])=>amount));
  const allInCaps=[...allInSeats].map(seat=>contributions.get(seat)??0).filter(amount=>amount>0&&amount<maximum);
  const caps=[...new Set([...allInCaps,maximum])].sort((a,b)=>a-b);
  let previous=0;
  return caps.map(cap=>{
    const amount=positive.reduce((sum,[,committed])=>sum+Math.max(0,Math.min(committed,cap)-previous),0);
    const contributors=positive.filter(([,committed])=>committed>previous).map(([seat])=>seat);
    const eligible=positive.filter(([seat,committed])=>committed>=cap&&!foldedSeats.has(seat)).map(([seat])=>seat);
    previous=cap;
    return {amount,cap,contributorSeats:contributors,eligibleSeats:eligible};
  }).filter(pot=>pot.amount>0);
}
