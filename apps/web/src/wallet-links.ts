import { stringToHex } from 'viem';
import { appFetch } from './platform-fetch';
import { forgetPortfolioSources } from './portfolio-sources';
import { WALLET_SIGNATURE_EVENT } from './sheet-state';
type Provider = { request(input: {method:string;params?:unknown[]}):Promise<unknown> };
export type LinkedWallets = {account:string;wallets:string[]};
async function call<T>(suffix='', input?:unknown, signal?:AbortSignal):Promise<T> {
  // Linking or removing a wallet changes the account's portfolio sources: never reuse the earlier list.
  if(input!==undefined)forgetPortfolioSources();
  const response=await appFetch('/api/account/wallets'+suffix,{method:input===undefined?'GET':'POST',credentials:'same-origin',headers:input===undefined?undefined:{'Content-Type':'application/json'},body:input===undefined?undefined:JSON.stringify(input),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});
  if(input!==undefined)forgetPortfolioSources();
  const value=await response.json();if(!response.ok)throw Error(value.error||'Your linked wallets could not be loaded.');return value;
}
const announce=(wallet:string,open:boolean)=>{if(typeof window!=='undefined'&&typeof CustomEvent==='function'&&typeof window.dispatchEvent==='function')window.dispatchEvent(new CustomEvent(WALLET_SIGNATURE_EVENT,{detail:{wallet,open}}));};
export const linkedWallets=(signal?:AbortSignal)=>call<LinkedWallets>('',undefined,signal);
export async function linkTradingWallet(provider:Provider,account:string,wallet:string,current:()=>boolean=()=>true) {
  const existing=await linkedWallets();
  if(existing.account.toLowerCase()!==account.toLowerCase()||!current())throw Error('Flurbo account changed. Reconnect.');
  if(existing.wallets.includes(wallet.toLowerCase()))return;
  const proof=await call<{id:string;message:string}>('/challenge',{wallet});
  const assertCurrent=async()=>{
    const addresses=await provider.request({method:'eth_accounts'});
    if(!current()||!Array.isArray(addresses)||String(addresses[0]).toLowerCase()!==wallet.toLowerCase())throw Error('MetaMask changed. Reconnect to link the selected account.');
  };
  await assertCurrent();
  announce(wallet,true);
  let signature:unknown;
  try{signature=await provider.request({method:'personal_sign',params:[stringToHex(proof.message),wallet]});}
  finally{announce(wallet,false);}
  await assertCurrent();
  await call('/verify',{id:proof.id,signature});
  if(typeof window!=='undefined'&&typeof Event==='function'&&typeof window.dispatchEvent==='function')window.dispatchEvent(new Event('flurbo:wallet-linked'));
}
