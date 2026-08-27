export interface EstimatedEv { action:string;ev:number;assumption:string; }
export interface StrategyWithEv { action:string;frequency:number;ev:number;evSource:"solver"|"model"; }
export function estimateActionEvs(input:{equity:number;pot:number;toCall:number;betSize:number;foldEquity?:number}):EstimatedEv[]{
  const equity=input.equity/100;const foldEquity=input.foldEquity??0.25;
  const results:EstimatedEv[]=[{action:"fold",ev:0,assumption:"Fold EV 기준점"}];
  if(input.toCall>0)results.push({action:"call",ev:equity*(input.pot+input.toCall)-input.toCall,assumption:"향후 베팅을 제외한 showdown equity"});
  else results.push({action:"check",ev:equity*input.pot,assumption:"즉시 showdown 가치"});
  const risk=Math.max(0,input.betSize);const calledPot=input.pot+risk*2;
  results.push({action:input.toCall>0?"raise":"bet",ev:foldEquity*input.pot+(1-foldEquity)*(equity*calledPot-risk),assumption:`상대 Fold ${Math.round(foldEquity*100)}% 가정`});
  return results.map(result=>({...result,ev:Math.round(result.ev*100)/100}));
}

export function attachActionEvs(strategy:{action:string;frequency:number;ev?:number}[],estimated:EstimatedEv[]):StrategyWithEv[]{
  return strategy.map(item=>{
    if(typeof item.ev==="number")return {action:item.action,frequency:item.frequency,ev:item.ev,evSource:"solver" as const};
    const fallback=estimated.find(value=>value.action===item.action);
    return {action:item.action,frequency:item.frequency,ev:fallback?.ev??0,evSource:"model" as const};
  });
}
