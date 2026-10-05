import {claimEvents,decodeClaim} from '../shared/claims.mjs';
import type {PilotNamespace} from './pilot';
import type {HybridMarket,MarketGroup} from './market-directory';

export type HybridNamespace=`hybrid-0x${string}`;
export type PortfolioNamespace=PilotNamespace|HybridNamespace;
export type HybridPortfolioGroup={kind:'hybrid';namespace:HybridNamespace;label:string;pool:string;closesAt:number};
export type PortfolioGroup=MarketGroup|HybridPortfolioGroup;
export const isHybridNamespace=(value:string):value is HybridNamespace=>/^hybrid-0x[0-9a-f]{40}$/.test(value);
export const isHybridGroup=(group:PortfolioGroup):group is HybridPortfolioGroup=>'kind' in group&&group.kind==='hybrid';
export function hybridNamespace(pool:string):HybridNamespace{
  const value=`hybrid-${pool.toLowerCase()}`;
  if(!isHybridNamespace(value))throw Error('Invalid hybrid pool');
  return value;
}
export function hybridPortfolioGroups(markets:Pick<HybridMarket,'pool'|'poolTitle'|'closesAt'>[]):HybridPortfolioGroup[]{
  const groups=new Map<string,HybridPortfolioGroup>();
  for(const market of markets){
    const pool=market.pool.toLowerCase();
    if(!groups.has(pool))groups.set(pool,{kind:'hybrid',namespace:hybridNamespace(pool),label:market.poolTitle,pool,closesAt:market.closesAt});
  }
  return [...groups.values()];
}
export const firstEvent=(scope:number):number=>claimEvents(scope)[0];
export function hybridClaimHref(pool:string,scope:number,mask:string):string{
  const base=`/markets/hybrid/${pool.toLowerCase()}/${firstEvent(scope)}`;
  let named:ReturnType<typeof decodeClaim>=null;
  try{named=decodeClaim(scope,mask,32);}catch{return base;}
  if(!named||!['AND','OR','EXACTLY_ONE'].includes(named.rule))return base;
  const [first,second,third]=named.legs,params=new URLSearchParams({answer:first.yes?'yes':'no'});
  if(second){params.set('other',String(second.event));params.set('otherAnswer',second.yes?'yes':'no');}
  if(third){params.set('third',String(third.event));params.set('thirdAnswer',third.yes?'yes':'no');}
  if(second)params.set('rule',named.rule);
  return `${base}?${params}`;
}
