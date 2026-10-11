import type {SnapshotRow} from './market-board-rows.ts';
import type {MarketDirectory} from './market-directory.ts';

// The last board a member saw, so a revisit renders at once and refreshes in place. Local to this browser.
export type BoardSnapshot={savedAt:number;directoryHash:string;rows:SnapshotRow[]};
const KEY='flurbo.board.v1:';
const local=()=>{try{return globalThis.localStorage;}catch{return undefined;}};

export function readBoardSnapshot(account:string,storage:Storage|undefined=local()):BoardSnapshot|null{
  try{
    const value=JSON.parse(storage?.getItem(KEY+account.toLowerCase())??'null');
    if(!value||!Number.isFinite(value.savedAt)||typeof value.directoryHash!=='string'||!Array.isArray(value.rows))return null;
    if(value.rows.some((r:SnapshotRow)=>!r||typeof r.key!=='string'||typeof r.path!=='string'||typeof r.question!=='string'))return null;
    return {savedAt:value.savedAt,directoryHash:value.directoryHash,rows:value.rows};
  }catch{return null;}
}

export function writeBoardSnapshot(account:string,value:{directoryHash:string;rows:SnapshotRow[]},now=Date.now(),storage:Storage|undefined=local()){
  try{storage?.setItem(KEY+account.toLowerCase(),JSON.stringify({savedAt:now,directoryHash:value.directoryHash,rows:value.rows}));}catch{}
}

// FNV-1a over the directory, enough to notice that the list of markets changed.
export function directoryHash(directory:MarketDirectory){
  const text=JSON.stringify([directory.agentPools,directory.oracleMarkets,directory.hybridMarkets]);
  let hash=0x811c9dc5;
  for(let i=0;i<text.length;i++){hash^=text.charCodeAt(i);hash=Math.imul(hash,0x01000193)>>>0;}
  return hash.toString(16).padStart(8,'0');
}

// The Yes price another market showed on this member's board in the last few minutes, for linked-question lists.
export function boardPrice(account: string | null | undefined, key: string, now = Date.now(), storage: Storage | undefined = local()) {
  if (!account) return null;
  const snapshot = readBoardSnapshot(account, storage);
  if (!snapshot || now - snapshot.savedAt > 5 * 60_000) return null;
  return snapshot.rows.find((row) => row.key === key)?.prices?.yes ?? null;
}
