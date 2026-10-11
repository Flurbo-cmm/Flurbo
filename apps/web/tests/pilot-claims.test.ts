import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFunctionData, encodeFunctionResult } from 'viem';
import { portfolioClaims, rememberClaimHint, rememberedClaims, rememberConfirmedClaim } from '../src/pilot-claims.ts';
import { poolFixture, owner, pool, hash } from './pool-fixture.ts';
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
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(key:string)=>db.get(key)??null,setItem:(key:string,value:string)=>db.set(key,value),get length(){return db.size;},key:(i:number)=>[...db.keys()][i]??null}});
  const manifest=poolFixture().manifest,portfolio=`hybrid-${pool}` as `hybrid-0x${string}`,agent=`practice-${pool.slice(2)}` as `hybrid-0x${string}`;
  const saved:any={hash,review:{manifest,action:'buy',requested:{owner,scope:3,mask:'8',quantity:'10000000'}}};
  try{
    rememberConfirmedClaim(saved);
    const hints=rememberedClaims(portfolio,pool,owner,2);
    assert.deepEqual(hints,[{scope:3,mask:'8'}]);
    assert.deepEqual(portfolioClaims(2,[3],hints,[])[0],hints[0]);
    assert.deepEqual(rememberedClaims(agent,pool,owner,2),[]);
    assert.deepEqual(rememberedClaims(portfolio,'0x'+'99'.repeat(20),owner,2),[]);
    assert.deepEqual(rememberedClaims(portfolio,pool,'0x'+'99'.repeat(20),2),[]);
    rememberConfirmedClaim(saved);assert.equal(rememberedClaims(portfolio,pool,owner,2).length,1);
    rememberConfirmedClaim({...saved,review:{...saved.review,action:'approve',requested:{owner,scope:3,mask:'4'}}});
    assert.deepEqual(rememberedClaims(portfolio,pool,owner,2),hints);
    const key=[...db.keys()][0];assert.ok(!db.get(key)!.includes('10000000'));
    const cache='flurbo.portfolio-cache.v1:'+owner.toLowerCase();
    db.set(cache,JSON.stringify({savedAt:1,identity:owner,pools:{[portfolio]:{savedAt:1},[`hybrid-0x${'44'.repeat(20)}`]:{savedAt:1}}}));
    rememberConfirmedClaim(saved);
    assert.deepEqual(Object.keys(JSON.parse(db.get(cache)!).pools),[`hybrid-0x${'44'.repeat(20)}`]);
    db.set(key,'[null,{"scope":999,"mask":"8"},{"scope":3,"mask":"malformed"}]');
    assert.deepEqual(rememberedClaims(portfolio,pool,owner,2),[]);
    db.set(key,'broken');assert.deepEqual(rememberedClaims(portfolio,pool,owner,2),[]);
    Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw Error('blocked');}});
    assert.doesNotThrow(()=>rememberConfirmedClaim(saved));
  }finally{if(previous)Object.defineProperty(globalThis,'localStorage',previous);else delete (globalThis as any).localStorage;}
});
test('claim hints are kept per hybrid pool and owner', () => {
  const db = new Map<string, string>(), previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => db.get(key) ?? null, setItem: (key: string, value: string) => db.set(key, value) } });
  const hybridPool = '0x' + '44'.repeat(20), namespace = ('hybrid-' + hybridPool) as `hybrid-0x${string}`;
  try {
    rememberClaimHint(namespace, hybridPool, owner, 2, { scope: 3, mask: '8' });
    assert.deepEqual(rememberedClaims(namespace, hybridPool, owner, 2), [{ scope: 3, mask: '8' }]);
    rememberClaimHint(namespace, hybridPool, owner, 2, { scope: 4, mask: '2' });
    rememberClaimHint(namespace, hybridPool, owner, 2, { scope: 3, mask: '8' });
    assert.deepEqual(rememberedClaims(namespace, hybridPool, owner, 2), [{ scope: 3, mask: '8' }]);
    assert.deepEqual(rememberedClaims(namespace, hybridPool, '0x' + '99'.repeat(20), 2), []);
  } finally { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete (globalThis as any).localStorage; }
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
