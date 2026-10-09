// Pinned markets, local to this browser and keyed by Mera account. Oldest pins drop off past the cap.
const KEY='flurbo.watchlist.v1:';
export const WATCHLIST_CAP=200;
const local=()=>{try{return globalThis.localStorage;}catch{return undefined;}};

export function readWatchlist(account:string,storage:Storage|undefined=local()):Set<string>{
  try{
    const value=JSON.parse(storage?.getItem(KEY+account.toLowerCase())??'[]');
    return new Set(Array.isArray(value)?value.filter((k:unknown):k is string=>typeof k==='string').slice(-WATCHLIST_CAP):[]);
  }catch{return new Set();}
}

export function toggleWatchlist(account:string,key:string,storage:Storage|undefined=local()):Set<string>{
  const list=[...readWatchlist(account,storage)];
  const next=list.includes(key)?list.filter(k=>k!==key):[...list,key].slice(-WATCHLIST_CAP);
  try{storage?.setItem(KEY+account.toLowerCase(),JSON.stringify(next));}catch{}
  return new Set(next);
}
