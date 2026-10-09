// Prices a member saw on their previous visit, to show what changed since. Local to this browser.
export type SeenPrices=Record<string,{yes:string|null;no:string|null}>;
const KEY='flurbo.seen.v1:';
export const SEEN_MIN_AGE_MS=5*60_000;
const MIN_ATOMS=5000n;
const local=()=>{try{return globalThis.localStorage;}catch{return undefined;}};

export function readSeen(account:string,storage:Storage|undefined=local()):{savedAt:number;prices:SeenPrices}|null{
  try{
    const value=JSON.parse(storage?.getItem(KEY+account.toLowerCase())??'null');
    if(!value||!Number.isFinite(value.savedAt)||!value.prices||typeof value.prices!=='object')return null;
    return {savedAt:value.savedAt,prices:value.prices};
  }catch{return null;}
}

export function writeSeen(account:string,prices:SeenPrices,now=Date.now(),storage:Storage|undefined=local()){
  try{storage?.setItem(KEY+account.toLowerCase(),JSON.stringify({savedAt:now,prices}));}catch{}
}

export function priceDelta(previousAtoms:string|null|undefined,currentAtoms:string|null|undefined):{atoms:bigint;direction:'up'|'down'}|null{
  if(!previousAtoms||!currentAtoms||!/^\d+$/.test(previousAtoms)||!/^\d+$/.test(currentAtoms))return null;
  const atoms=BigInt(currentAtoms)-BigInt(previousAtoms);
  if((atoms<0n?-atoms:atoms)<MIN_ATOMS)return null;
  return {atoms,direction:atoms>0n?'up':'down'};
}
