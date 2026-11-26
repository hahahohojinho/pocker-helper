/** Cash-game rake: percent of each contested pot that sees a flop, capped in BB per pot. */
export interface RakeSetting { percent:number;capBb:number; }

export const NO_RAKE:RakeSetting={percent:0,capBb:0};
/** Same bound as the solver request (tools/dcfr-core/src/request.rs MAX_RAKE_PERCENT). */
export const MAX_RAKE_PERCENT=10;
export const MAX_RAKE_CAP_BB=100;
const RAKE_STORAGE_KEY="rangelab.rake.v1";

const inRange=(value:unknown,max:number):value is number=>typeof value==="number"&&Number.isFinite(value)&&value>=0&&value<=max;

/** A rake setting from untrusted input (storage or form); anything invalid means no rake. */
export function parseRakeSetting(value:unknown):RakeSetting{
  if(!value||typeof value!=="object")return NO_RAKE;
  const {percent,capBb}=value as Record<string,unknown>;
  if(!inRange(percent,MAX_RAKE_PERCENT)||!inRange(capBb,MAX_RAKE_CAP_BB))return NO_RAKE;
  return percent>0&&capBb>0?{percent,capBb}:NO_RAKE;
}

export const hasRake=(setting:RakeSetting)=>setting.percent>0&&setting.capBb>0;

export function loadRakeSetting(storage:Pick<Storage,"getItem">|null):RakeSetting{
  try{
    const saved=storage?.getItem(RAKE_STORAGE_KEY);
    return saved?parseRakeSetting(JSON.parse(saved)):NO_RAKE;
  }catch{
    return NO_RAKE;
  }
}

export function saveRakeSetting(storage:Pick<Storage,"setItem">|null,setting:RakeSetting){
  try{storage?.setItem(RAKE_STORAGE_KEY,JSON.stringify(setting));}catch{/* Storage can be unavailable; the setting then lasts for this page only. */}
}
