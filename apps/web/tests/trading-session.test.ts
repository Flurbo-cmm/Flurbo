import {test} from 'node:test';
import assert from 'node:assert/strict';
import {watchTradingWallet} from '../src/auth/trading-session.ts';
const a='0x'+'11'.repeat(20),b='0x'+'22'.repeat(20),login='0x'+'33'.repeat(20);
const flush=()=>new Promise(r=>setImmediate(r));
function fixture(){
  const surface=new EventTarget(),listeners=new Map<string,()=>void>(),calls:string[]=[],states:any[]=[];
  let accounts=[a],known=[a,b],account=login,fail=false;
  const provider={request:async({method}:any)=>{calls.push(method);assert.equal(method,'eth_accounts');return accounts;},on:(event:string,fn:()=>void)=>listeners.set(event,fn),removeListener:(event:string)=>listeners.delete(event)};
  const links=async()=>{if(fail)throw Error();return {account,wallets:known};};
  return {surface,provider,links,publish:(s:any)=>states.push(s),states,calls,listeners,set:(v:any)=>{if(v.accounts)accounts=v.accounts;if(v.known)known=v.known;if(v.account)account=v.account;if(v.fail)fail=true;}};
}
test('linked wallets restore on fresh mounts and focus without permissions or signatures',async()=>{
  const f=fixture();let stop=watchTradingWallet({...f,account:login});await flush();assert.equal(f.states.at(-1).owner,a);
  stop();stop=watchTradingWallet({...f,account:login});await flush();assert.equal(f.states.at(-1).owner,a);
  f.surface.dispatchEvent(new Event('focus'));await flush();assert.equal(f.states.at(-1).owner,a);assert.ok(f.calls.every(c=>c==='eth_accounts'));stop();assert.equal(f.listeners.size,0);
});
test('wallet and chain changes invalidate immediately and select only the currently authorized linked wallet',async()=>{
  const f=fixture(),stop=watchTradingWallet({...f,account:login});await flush();
  f.set({accounts:[b]});f.listeners.get('accountsChanged')!();assert.equal(f.states.at(-1).owner,'');await flush();assert.equal(f.states.at(-1).owner,b);
  f.listeners.get('chainChanged')!();assert.equal(f.states.at(-1).owner,'');await flush();assert.equal(f.states.at(-1).owner,b);
  f.set({accounts:[]});f.listeners.get('accountsChanged')!();await flush();assert.equal(f.states.at(-1).status,'disconnected');stop();
});
test('unlinked wallets, different Mera accounts, failed link reads and disconnect never restore a signer',async()=>{
  for(const change of [{known:[]},{account:b},{fail:true}]){
    const f=fixture();f.set(change);const stop=watchTradingWallet({...f,account:login});await flush();assert.equal(f.states.at(-1).owner,'');stop();
  }
  const f=fixture(),stop=watchTradingWallet({...f,account:login});await flush();f.listeners.get('disconnect')!();assert.equal(f.states.at(-1).status,'disconnected');stop();
});
test('late account checks cannot reconnect a disconnected or unmounted page',async()=>{
  const f=fixture();let release!:(v:any)=>void;
  const stop=watchTradingWallet({...f,account:login,links:()=>new Promise(r=>{release=r;})});await flush();
  f.listeners.get('disconnect')!();release({account:login,wallets:[a]});await flush();assert.equal(f.states.at(-1).status,'disconnected');
  const count=f.states.length;stop();f.surface.dispatchEvent(new Event('focus'));await flush();assert.equal(f.states.length,count);
});
