import {appFetch} from './platform-fetch';
import {takeEarly} from './prefetch';
import {isPracticeNamespace,type PilotNamespace,type PilotState} from './pilot';
export type MarketGroup={namespace:PilotNamespace;label:string;pool:string;closesAt:number};
export type MarketSnapshot={manifest:PilotState['manifest'];snapshot:PilotState['snapshot'];open:boolean;resolved:boolean;prices:{event:number;yes:string|null;no:string|null}[]};
export async function loadMarketDirectory(signal:AbortSignal):Promise<MarketGroup[]>{
  const response=(await takeEarly('/api/market-directory'))??await appFetch('/api/market-directory',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(20000)])});
  if(!response.ok)throw Error('Markets could not be loaded. Please retry.');
  const value=await response.json();
  if(value.schema!=='flurbo.market-directory.v1'||!Array.isArray(value.markets)||value.markets.length>25||value.markets.some((r:MarketGroup)=>!(r.namespace==='pilot'||isPracticeNamespace(r.namespace))||typeof r.label!=='string'||!/^0x[0-9a-f]{40}$/.test(r.pool)||!Number.isSafeInteger(r.closesAt))||new Set(value.markets.map((r:MarketGroup)=>r.namespace)).size!==value.markets.length)throw Error('Market directory is unavailable.');
  return value.markets;
}
export function marketStatus(data:MarketSnapshot,now:number){
  if(data.resolved)return 'Settled';
  if(now>=data.manifest.publication.draft.closesAt)return 'Closed';
  return data.open?'Open':'Unavailable';
}
