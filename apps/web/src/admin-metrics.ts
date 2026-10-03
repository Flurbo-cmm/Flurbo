import {appFetch} from './platform-fetch';

// Operator-only growth metrics (server/user-metrics.mjs). Members never receive this data.
export type TradeStats={buys:number;singles:number;combined:number;sells:number;redeems:number;spentAtoms:string;receivedAtoms:string;markets:number;
  byRule:Record<string,number>;byLegs:Record<string,number>;firstBuyAt:number|null;lastBuyAt:number|null};
export type FunnelStep={key:string;label:string;count:number;detail?:{emailVerified:number;withdrawn:number}};
export type DailyRow={day:string;signIns:number;requests:number;verified:number;approvals:number;firstBets:number;bets:number;singles:number;combined:number};
export type MetricsUser={account:string;team:boolean;firstSignIn:number|null;lastSignIn:number|null;
  application:{state:string;decision:string|null;createdAt:number|null;verifiedAt:number|null;approvedAt:number|null}|null;
  approved:boolean;wallets:number;linkedAt:number|null;starter:boolean;trades:TradeStats};
export type MetricsMarket=TradeStats&{namespace:string;label:string;pool:string;closesAt:number|null;traders:number;
  scanned:{through:number;target:number;start:number;percent:number;complete:boolean}};
export type FundWallet={address:string;balance:string;unit:string;left:number;leftLabel:string;threshold:string;low:boolean};
export type MetricsReport={schema:'flurbo.user-metrics.v1';generatedAt:number;funds:{checkedAt:number;dispenser:FundWallet|null;starter:FundWallet|null}|null;
  notes:{signInsTrackedSince:number;applications:'ok'|'unavailable'|'not_configured';excludedAccounts:number;inviteOnly:boolean};
  funnel:FunnelStep[];last24h:{signIns:number;requests:number;approvals:number;firstBets:number;bets:number;singles:number;combined:number};
  daily:DailyRow[];totals:TradeStats;markets:MetricsMarket[];sync:{complete:boolean;lastRunAt:number|null};
  users:MetricsUser[];agents:{agentId:string|null;account:string|null;wallet:string;trades:TradeStats}[];unlinked:{wallet:string;trades:TradeStats}[]};

async function call<T>(path:string,post=false):Promise<T>{
  const response=await appFetch(path,{method:post?'POST':'GET',credentials:'same-origin',cache:'no-store',redirect:'error',
    headers:post?{'Content-Type':'application/json'}:undefined,body:post?'{}':undefined,signal:AbortSignal.timeout(post?28_000:20_000)});
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(result.error||'Metrics could not be loaded. Try again.');
  return result as T;
}
export const loadMetrics=()=>call<MetricsReport>('/api/admin/metrics');
export const scanMoreTrades=()=>call<{sync:{complete:boolean}}>('/api/admin/metrics/sync',true);

export const ausd=(atoms:string)=>(Number(BigInt(atoms))/1e6).toLocaleString(undefined,{maximumFractionDigits:2});
export const short=(address:string)=>`${address.slice(0,6)}…${address.slice(-4)}`;
export const when=(ms:number|null)=>ms===null?'—':new Date(ms).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
export const share=(part:number,whole:number)=>whole?Math.round(part*100/whole)+'%':'—';
export const RULE_LABELS:Record<string,string>={SINGLE:'Single answer',AND:'All must happen',OR:'At least one',EXACTLY_ONE:'Exactly one',AT_LEAST_TWO:'At least two',OTHER:'Other combination'};
