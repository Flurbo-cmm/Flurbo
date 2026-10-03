import {appFetch} from './platform-fetch';
import type {TradeActivity} from './portfolio-performance';
export type AgentExecution=Omit<TradeActivity,'quantity'|'cash'|'index'>&{quantity:string;cash:string;agentId:string;agentName:string};
export type PortfolioSources={account:string;wallets:string[];agentWallets?:string[];agentExecutions?:AgentExecution[]};
// Several parts of a page ask for the account's wallets as it opens, one after another. A read in flight, or finished
// less than REUSE_MS ago, is shared; linking or removing a wallet clears it (forgetPortfolioSources).
const REUSE_MS=2_000;
let shared:{at:number|null;promise:Promise<PortfolioSources>}|null=null;
export function forgetPortfolioSources(){shared=null;}
// A wallet linked anywhere (this page, the MetaMask link flow, another component) announces itself; the next read is
// fresh. Registered when this module loads, so it runs before any page's own listener reloads the list.
if(typeof window!=='undefined'&&typeof window.addEventListener==='function')window.addEventListener('flurbo:wallet-linked',forgetPortfolioSources);
export async function portfolioSources(signal?:AbortSignal):Promise<PortfolioSources>{
  if(!shared||(shared.at!==null&&Date.now()-shared.at>=REUSE_MS)){
    const entry:{at:number|null;promise:Promise<PortfolioSources>}={at:null,promise:readSources()};
    shared=entry;entry.promise.then(()=>{entry.at=Date.now();},()=>{if(shared===entry)shared=null;});
  }
  const promise=shared.promise;
  const value=signal?await new Promise<PortfolioSources>((resolve,reject)=>{if(signal.aborted)return reject(signal.reason);const stop=()=>reject(signal.reason);
    signal.addEventListener('abort',stop,{once:true});promise.then(v=>{signal.removeEventListener('abort',stop);resolve(v);},e=>{signal.removeEventListener('abort',stop);reject(e);});}):await promise;
  return structuredClone(value);
}
async function readSources():Promise<PortfolioSources>{
  const response=await appFetch('/api/account/portfolio-sources',{credentials:'same-origin',signal:AbortSignal.timeout(30000)});
  const value=await response.json();if(!response.ok)throw Error(value.error||'Your portfolio could not be loaded.');return value;
}
// Receipt-verified recent executions make trades visible before the historical
// index catches up. Indexed logs take precedence and are never counted twice.
export function mergeAgentActivity(trades:TradeActivity[],executions:AgentExecution[]):TradeActivity[]{
  const seen=new Set(trades.map(t=>t.pool.toLowerCase()+':'+t.hash.toLowerCase())),result=[...trades];
  for(const e of executions){const key=e.pool.toLowerCase()+':'+e.hash.toLowerCase();if(seen.has(key))continue;seen.add(key);result.push({...e,quantity:BigInt(e.quantity),cash:BigInt(e.cash),index:0});}
  return result.sort((a,b)=>a.block-b.block||a.index-b.index);
}
export function tradeAgent(trade:TradeActivity,executions:AgentExecution[]){
  return executions.find(e=>e.pool===trade.pool&&e.hash===trade.hash&&e.owner===trade.owner&&e.scope===trade.scope&&e.mask===trade.mask&&e.action===trade.action);
}
