import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {semanticError} from '../src/semantics.ts';
import {executor} from '../src/node/executor.ts';
const f=JSON.parse(readFileSync(new URL('../../../protocol/fixtures/semantics.json',import.meta.url),'utf8'));
test('semantic assessment conformance: bindings, freshness, payout matrix and unknowns',()=>{
  for(const c of f.cases)assert.equal(semanticError(c.result,{...f.deployment,...c.claim},f.now),c.error,c.name);
});
test('custom execution and direct signing reject collisions before signer, nonce or approval',async()=>{
  const blocked=['SEMANTIC_COLLISION','SEMANTICS_UNKNOWN','SEMANTICS_UNAVAILABLE'];
  for(const code of blocked){
    const c=f.cases.find((c:any)=>c.error===code), logs:string[]=[];
    const entry:any={id:'test',status:'planned',action:'buy',claim:{scope:3,mask:'8'},quantityAtoms:'1000000'};
    const client={validateTrade:async()=>c.result};
    const chain=new Proxy({}, {get(){throw Error('chain should not be reached');}});
    const journal={locked:async(fn:any)=>fn({entries:[entry]})};
    const ex=executor({chain:chain as any,client:client as any,journal:journal as any,signer:{address:'0x'+'4'.repeat(40),signTransaction:()=>{throw Error('must not sign');}} as any,
      now:()=>f.now,policy:()=>{throw Error('must not reach policy');},liveAllowed:()=>({allowed:true,reason:null}),log:e=>logs.push(e)});
    const actual=code;
    assert.equal((await ex.execute({decisionId:'x',deployment:f.deployment,action:'buy',claim:{scope:3,mask:8n},quantityAtoms:1000000n,quoteAtoms:500000n,slippageBps:50,quoteBlock:{timestamp:f.now,number:1n,hash:'0x'}} as any) as any).reason,actual);
    assert.equal(await ex.sign('test',f.deployment),null);assert.equal(entry.status,'abandoned');assert.equal(entry.note,actual);assert.ok(logs.includes(actual));
  }
});
test('a valid disabled answer passes the guard and is logged; a failed request is never treated as disabled',async()=>{
  const disabled=f.cases.find((c:any)=>c.name==='disabled proceeds without semantic assurance').result;
  for(const [validateTrade,expected] of [[async()=>disabled,null],[async()=>{throw Error('offline');},'SEMANTICS_UNAVAILABLE'],[async()=>({code:'SEMANTICS_UNAVAILABLE'}),'SEMANTICS_UNAVAILABLE']] as const){
    const logs:string[]=[], entry:any={id:'test',status:'planned',action:'buy',claim:{scope:3,mask:'8'},quantityAtoms:'1000000'};
    const chain=new Proxy({}, {get(){throw Error('reached chain');}});
    const ex=executor({chain:chain as any,client:{validateTrade} as any,journal:{locked:async(fn:any)=>fn({entries:[entry]})} as any,signer:{address:'0x'+'4'.repeat(40),signTransaction:()=>{throw Error('must not sign');}} as any,
      now:()=>f.now,policy:()=>{throw Error('must not reach policy');},liveAllowed:()=>({allowed:true,reason:null}),log:e=>logs.push(e)});
    if(expected===null){
      await assert.rejects(ex.sign('test',f.deployment));
      assert.equal(entry.status,'planned');assert.ok(logs.includes('SEMANTICS_DISABLED'));
    } else {
      assert.equal(await ex.sign('test',f.deployment),null);assert.equal(entry.note,expected);assert.ok(!logs.includes('SEMANTICS_DISABLED'));
    }
  }
});
