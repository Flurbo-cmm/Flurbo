import type {HistoryRead,PoolRead} from './portfolio-loader.ts';
import type {ActivityLog} from './portfolio-performance';

// Past trades and collected payouts of this account's own wallets, kept in this browser so the Activity and
// Collected views fill at once while the verified history reloads. Cached activity is display only: PnL still
// waits for a fresh, complete history that matches current holdings.
const KEY='flurbo.portfolio-history.v1:';
const MAX_AGE_MS=30*86_400_000,MAX_LOGS=500;
type Entry={savedAt:number;pool:string;history?:HistoryRead;payouts?:HistoryRead};
type Stored={identity:string;pools:Record<string,Entry>};

const validLog=(l:any):l is ActivityLog=>!!l&&typeof l.name==='string'&&/^0x[0-9a-f]{64}$/i.test(l.hash)&&Number.isSafeInteger(l.index)&&Number.isSafeInteger(l.block)&&typeof l.args==='object'&&l.args!==null;
const validRead=(r:any):r is HistoryRead=>!!r&&typeof r.complete==='boolean'&&Array.isArray(r.logs)&&r.logs.length<=MAX_LOGS&&r.logs.every(validLog);
function load(account:string):Stored|null{
  try{const raw=localStorage.getItem(KEY+account.toLowerCase());return raw?JSON.parse(raw):null;}catch{return null;}
}
const own=(read:HistoryRead,owners:Set<string>):HistoryRead=>({complete:read.complete,through:read.through,target:read.target,
  logs:read.logs.filter(l=>owners.has(String(l.args.trader||l.args.owner||'').toLowerCase())).slice(-MAX_LOGS)});

export function readHistoryCache(account:string,identity:string,now=Date.now()):Record<string,Entry>{
  const stored=load(account),out:Record<string,Entry>={};
  if(!stored||stored.identity!==identity||typeof stored.pools!=='object'||!stored.pools)return out;
  for(const [namespace,entry] of Object.entries(stored.pools)){
    if(!entry||!Number.isFinite(entry.savedAt)||now-entry.savedAt>MAX_AGE_MS||typeof entry.pool!=='string')continue;
    if(entry.history!==undefined&&!validRead(entry.history)||entry.payouts!==undefined&&!validRead(entry.payouts))continue;
    if(!entry.history&&!entry.payouts)continue;
    out[namespace]=entry;
  }
  return out;
}

export function writeHistoryCache(account:string,identity:string,namespace:string,read:PoolRead,now=Date.now()){
  const history=read.history&&!read.historyError?read.history:undefined,payouts=read.payouts&&!read.payoutError?read.payouts:undefined;
  if(!history&&!payouts)return;
  try{
    const owners=new Set(identity.split(',').map(x=>x.toLowerCase())),current=load(account);
    const stored:Stored=current&&current.identity===identity&&current.pools?current:{identity,pools:{}};
    const old=stored.pools[namespace];
    // A scan still catching up never replaces a longer saved history.
    const next=(fresh:HistoryRead|undefined,saved:HistoryRead|undefined)=>{
      const mine=fresh&&own(fresh,owners);
      return mine&&!(saved&&!mine.complete&&saved.logs.length>mine.logs.length)?mine:saved;
    };
    const nextHistory=next(history,old?.history),nextPayouts=next(payouts,old?.payouts);
    stored.pools[namespace]={savedAt:now,pool:read.group.pool,...(nextHistory?{history:nextHistory}:{}),...(nextPayouts?{payouts:nextPayouts}:{})};
    localStorage.setItem(KEY+account.toLowerCase(),JSON.stringify(stored));
  }catch{/* Storage full or unavailable: Portfolio still loads normally. */}
}
