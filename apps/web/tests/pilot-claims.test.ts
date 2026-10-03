import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFunctionData, encodeFunctionResult } from 'viem';
import { portfolioClaims, rememberedClaims, rememberConfirmedClaim } from '../src/pilot-claims.ts';
import { pilotFixture, owner, pool, hash } from './pilot-fixture.ts';
import { pilotService } from '../server/pilot.mjs';
import { pilotPoolAbi } from '../shared/pilot.mjs';

test('active pool scopes discover all AND and OR choices without a history scan',()=>{
  const claims=portfolioClaims(4,[1,2,3,7],[],[]);
  for(const mask of ['1','2','4','8','7','11','13','14'])assert.ok(claims.some(c=>c.scope===3&&c.mask===mask));
  for(const mask of ['1','2','4','8','16','32','64','128','254','253','251','247','239','223','191','127'])assert.ok(claims.some(c=>c.scope===7&&c.mask===mask));
  for(const mask of ['22','232'])assert.ok(claims.some(c=>c.scope===7&&c.mask===mask));
  assert.equal(claims.length,50);
  assert.equal(new Set(claims.map(c=>c.scope+':'+c.mask)).size,claims.length);
  assert.equal(portfolioClaims(4,[0,15,16,-1],[],[]).length,8);
  assert.ok(portfolioClaims(4,[3],[],[{scope:3,mask:'6'}]).some(c=>c.mask==='6'));
});
test('recent hints take first-page priority and are scoped to wallet, pool and namespace',()=>{
  const db=new Map<string,string>(),previous=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(key:string)=>db.get(key)??null,setItem:(key:string,value:string)=>db.set(key,value)}});
  const manifest=pilotFixture().manifest;
  const saved:any={hash,review:{manifest,action:'buy',requested:{owner,scope:3,mask:'8',quantity:'10000000'}}};
  try{
    rememberConfirmedClaim('rehearsal',saved);
    const hints=rememberedClaims('rehearsal',pool,owner,2);
    assert.deepEqual(hints,[{scope:3,mask:'8'}]);
    assert.deepEqual(portfolioClaims(2,[3],hints,[])[0],hints[0]);
    assert.deepEqual(rememberedClaims('pilot',pool,owner,2),[]);
    assert.deepEqual(rememberedClaims('rehearsal','0x'+'99'.repeat(20),owner,2),[]);
    assert.deepEqual(rememberedClaims('rehearsal',pool,'0x'+'99'.repeat(20),2),[]);
    rememberConfirmedClaim('rehearsal',saved);assert.equal(rememberedClaims('rehearsal',pool,owner,2).length,1);
    rememberConfirmedClaim('rehearsal',{...saved,review:{...saved.review,action:'approve',requested:{owner,scope:3,mask:'4'}}});
    assert.deepEqual(rememberedClaims('rehearsal',pool,owner,2),hints);
    const key=[...db.keys()][0];assert.ok(!db.get(key)!.includes('10000000'));
    db.set(key,'[null,{"scope":999,"mask":"8"},{"scope":3,"mask":"malformed"}]');
    assert.deepEqual(rememberedClaims('rehearsal',pool,owner,2),[]);
    db.set(key,'broken');assert.deepEqual(rememberedClaims('rehearsal',pool,owner,2),[]);
    Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw Error('blocked');}});
    assert.doesNotThrow(()=>rememberConfirmedClaim('rehearsal',saved));
  }finally{if(previous)Object.defineProperty(globalThis,'localStorage',previous);else delete (globalThis as any).localStorage;}
});
test('account discovers scopes at its verified block without attributing them to a wallet',async()=>{
  const f=pilotFixture(),calls:any[]=[];
  const rpc=async(method:string,params:any[])=>{
    if(method==='eth_call'&&params[0].to===pool){
      const {functionName}=decodeFunctionData({abi:pilotPoolAbi,data:params[0].data});
      if(functionName==='factors'){
        calls.push(params);return encodeFunctionResult({abi:pilotPoolAbi,functionName,result:[{scope:3,values:[0n,0n,0n,10_000_000n]}]});
      }
    }
    return f.rpc(method,params);
  };
  const result=await pilotService({manifest:f.manifest,rpc}).account(owner);
  assert.deepEqual(result.claimScopes,[3]);assert.equal(calls[0][1],'0x64');
  assert.equal(result.rows,undefined);assert.equal(result.wallet.address,owner);
});

test('price impact compares the average price of a size with one share of the same claim', async () => {
  const { priceImpact } = await import('../src/pilot.ts');
  const buy = { action: 'buy', requested: { action: 'buy', quantity: '10000000' }, impact: { quoteAtoms: '6201000', oneShareAtoms: '512500' } } as any;
  assert.deepEqual(priceImpact(buy), { averageAtoms: 620100n, bps: 2099 });
  const sell = { action: 'sell', requested: { action: 'sell', quantity: '2000000' }, impact: { quoteAtoms: '900000', oneShareAtoms: '500000' } } as any;
  assert.deepEqual(priceImpact(sell), { averageAtoms: 450000n, bps: 1000 });
  assert.equal(priceImpact({ ...buy, requested: { action: 'buy', quantity: '1000000' } }), null);
  assert.equal(priceImpact({ ...buy, impact: null }), null);
});
