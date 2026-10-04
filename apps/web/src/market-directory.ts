import {appFetch} from './platform-fetch';
import {takeEarly} from './prefetch';
import {isPracticeNamespace,type PilotNamespace,type PilotState} from './pilot';
export type MarketGroup={namespace:PilotNamespace;label:string;pool:string;closesAt:number};
export type OracleMarket={id:string;pool:string;poolTitle:string;eventIndex:number;question:string;closesAt:number;observationEndsAt:number};
export type OracleMarketSummary={schema:'flurbo.oracle-market.v1';id:string;pool:string;marketNow:number;funded:boolean;resolved:boolean;prices:{yes:string|null;no:string|null}};
export type HybridMarket={id:string;pool:string;poolTitle:string;eventIndex:number;question:string;route:'mechanical'|'reality';closesAt:number;observationEndsAt:number};
export type HybridMarketSummary={schema:'flurbo.hybrid-market.v1';id:string;pool:string;marketNow:number;funded:boolean;resolved:boolean;prices:{yes:string|null;no:string|null}};
export type MarketSnapshot={manifest:PilotState['manifest'];snapshot:PilotState['snapshot'];open:boolean;resolved:boolean;prices:{event:number;yes:string|null;no:string|null}[]};
export type MarketDirectory={groups:MarketGroup[];oracleMarkets:OracleMarket[];hybridMarkets:HybridMarket[]};
export async function loadMarketDirectory(signal:AbortSignal):Promise<MarketDirectory>{
  const response=(await takeEarly('/api/market-directory'))??await appFetch('/api/market-directory',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(20000)])});
  if(!response.ok)throw Error('Markets could not be loaded. Please retry.');
  const value=await response.json();
  const oracleMarkets=value.oracleMarkets??[];
  const hybridMarkets=value.hybridMarkets??[];
  if(value.schema!=='flurbo.market-directory.v1'||!Array.isArray(value.markets)||value.markets.length>25||value.markets.some((r:MarketGroup)=>!(r.namespace==='pilot'||isPracticeNamespace(r.namespace))||typeof r.label!=='string'||!/^0x[0-9a-f]{40}$/.test(r.pool)||!Number.isSafeInteger(r.closesAt))||new Set(value.markets.map((r:MarketGroup)=>r.namespace)).size!==value.markets.length
    ||!Array.isArray(oracleMarkets)||oracleMarkets.length>256||oracleMarkets.some((r:OracleMarket)=>!r||typeof r.id!=='string'||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(r.id)||!/^0x[0-9a-f]{40}$/i.test(r.pool)||typeof r.poolTitle!=='string'||!r.poolTitle.trim()||typeof r.question!=='string'||!r.question.trim()||!Number.isInteger(r.eventIndex)||r.eventIndex<0||r.eventIndex>31||!Number.isSafeInteger(r.closesAt)||!Number.isSafeInteger(r.observationEndsAt))||new Set(oracleMarkets.map((r:OracleMarket)=>r.id)).size!==oracleMarkets.length
    ||!Array.isArray(hybridMarkets)||hybridMarkets.length>512||hybridMarkets.some((r:HybridMarket)=>!r||typeof r.id!=='string'||!/^0x[0-9a-f]{40}-\d{1,2}$/i.test(r.id)||!/^0x[0-9a-f]{40}$/i.test(r.pool)||typeof r.poolTitle!=='string'||!r.poolTitle.trim()||typeof r.question!=='string'||!r.question.trim()||!['mechanical','reality'].includes(r.route)||!Number.isInteger(r.eventIndex)||r.eventIndex<0||r.eventIndex>31||r.id.toLowerCase()!==`${r.pool.toLowerCase()}-${r.eventIndex}`||!Number.isSafeInteger(r.closesAt)||!Number.isSafeInteger(r.observationEndsAt))||new Set(hybridMarkets.map((r:HybridMarket)=>r.id.toLowerCase())).size!==hybridMarkets.length)throw Error('Market directory is unavailable.');
  return {groups:value.markets,oracleMarkets,hybridMarkets};
}
export function marketStatus(data:MarketSnapshot,now:number){
  if(data.resolved)return 'Settled';
  if(now>=data.manifest.publication.draft.closesAt)return 'Closed';
  return data.open?'Open':'Unavailable';
}
