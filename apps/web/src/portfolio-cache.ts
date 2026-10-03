import type {PoolRead} from './portfolio-loader';

// The last complete holdings per market for one account and wallet set, kept in this browser so Portfolio can
// show them immediately while fresh balances load. Only non-zero rows are kept; history is never cached.
// Cached rows are labelled as such and cannot start a payout; a fresh read replaces each market once complete.
const KEY='flurbo.portfolio-cache.v1:';
const MAX_AGE_MS=7*86_400_000;
type Stored={savedAt:number;identity:string;pools:Record<string,{savedAt:number;group:PoolRead['group'];manifest?:PoolRead['manifest'];owners:PoolRead['owners'];blocks:PoolRead['blocks']}>};

const validRow=(r:any)=>r&&Number.isInteger(r.scope)&&r.scope>0&&typeof r.mask==='string'&&/^\d+$/.test(r.mask)&&typeof r.quantity==='string'&&/^\d+$/.test(r.quantity)
  &&(r.payoutAtoms===null||typeof r.payoutAtoms==='string'&&/^\d+$/.test(r.payoutAtoms));
function load(account:string):Stored|null{
  try{const raw=localStorage.getItem(KEY+account.toLowerCase());return raw?JSON.parse(raw):null;}catch{return null;}
}

export function readPortfolioCache(account:string,identity:string,now=Date.now()):Record<string,PoolRead>{
  const stored=load(account),out:Record<string,PoolRead>={};
  if(!stored||stored.identity!==identity||typeof stored.pools!=='object')return out;
  for(const [namespace,pool] of Object.entries(stored.pools)){
    if(!pool||!Number.isFinite(pool.savedAt)||now-pool.savedAt>MAX_AGE_MS||typeof pool.group?.pool!=='string'||typeof pool.owners!=='object')continue;
    if(!Object.values(pool.owners).every(rows=>Array.isArray(rows)&&rows.every(validRow)))continue;
    out[namespace]={group:pool.group,manifest:pool.manifest,owners:pool.owners,blocks:pool.blocks||{},holdingsComplete:false,cachedAt:pool.savedAt};
  }
  return out;
}

// A confirmed trade makes the saved holdings of that market out of date: drop them for every account in this
// browser, so Portfolio waits for the fresh read of that market instead of showing pre-trade numbers.
export function forgetPortfolioCachePool(namespace:string){
  try{
    for(let i=localStorage.length-1;i>=0;i--){
      const key=localStorage.key(i);if(!key?.startsWith(KEY))continue;
      const stored=JSON.parse(localStorage.getItem(key)||'null') as Stored|null;
      if(!stored?.pools?.[namespace])continue;
      delete stored.pools[namespace];localStorage.setItem(key,JSON.stringify(stored));
    }
  }catch{/* Optional cache: nothing to undo. */}
}

export function writePortfolioCache(account:string,identity:string,namespace:string,read:PoolRead,now=Date.now()){
  if(!read.holdingsComplete||read.error||read.cachedAt)return;
  try{
    const current=load(account),stored:Stored=current&&current.identity===identity?current:{savedAt:now,identity,pools:{}};
    const owners=Object.fromEntries(Object.entries(read.owners).map(([owner,rows])=>[owner,rows.filter(r=>BigInt(r.quantity)>0n)]));
    stored.pools[namespace]={savedAt:now,group:read.group,manifest:read.manifest,owners,blocks:read.blocks};
    stored.savedAt=now;
    localStorage.setItem(KEY+account.toLowerCase(),JSON.stringify(stored));
  }catch{/* Storage full or unavailable: Portfolio still loads normally. */}
}
