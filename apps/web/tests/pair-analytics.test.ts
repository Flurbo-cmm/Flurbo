import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { decodeFunctionData, encodeFunctionResult } from 'viem';
import { pairAnalytics, runPairModel } from '../server/pair-analytics.mjs';
import { certifiedPair, pairInput } from '../server/pair-math.mjs';
import { simulatePairPurchase } from '../server/pair-sensitivity.mjs';
import { pilotPoolAbi, pilotCash } from '../shared/pilot.mjs';
import { pilotFixture, hash } from './pilot-fixture.ts';
import { localApi } from '../server/local-api.mjs';
import { rustExample } from './rust-example.ts';

const fixtures=JSON.parse(await readFile(new URL('./fixtures/pair-analytics.json',import.meta.url),'utf8'));
const model=(input:string)=>runPairModel(input,{file:rustExample('pair_analytics')});
test('integer interval results match independent 90-digit Decimal fixtures, including rare events',()=>{
  for(const row of fixtures)assert.deepEqual(certifiedPair(row.state).values,row.displayed,row.name);
});
test('Rust factor elimination matches independently enumerated high-precision fixtures',async()=>{
  for(const row of fixtures){
    const result=await model(pairInput(row.state));
    for(const [key,expected] of Object.entries(row.precise))assert.ok(Math.abs(result[key]-Number(expected))<2e-13,`${row.name} ${key}`);
    assert.ok(result.joint<=Math.min(result.a,result.b)+1e-13);
    assert.ok(result.joint>=Math.max(0,result.a+result.b-1)-1e-13);
    assert.ok(Math.abs(result.a-(result.givenYes*result.b+result.givenNo*(1-result.b)))<1e-13);
  }
});
test('invalid tables, graph width, pair, atoms and domain fail closed',()=>{
  const base=fixtures[0].state;
  for(const change of [{a:1,b:1},{b:4},{events:5},{order:[0,0,2,3]},{liquidity:'0'},{liquidity:'-1'},
    {factors:[{scope:3,values:['0']}]},{factors:[{scope:16,values:['0','1']}]},
    {factors:[{scope:1,values:['0',String(2n**128n)]}]},
    {factors:[{scope:1,values:['0','1000000001']}]},
    {factors:[3,5,9,6,10,12].map(scope=>({scope,values:['0','0','0','1']}))}])assert.throws(()=>certifiedPair({...base,...change}));
});

function setup(){
  const now=1_800_000_000,f=pilotFixture(now,4),calls:any[]=[];
  let clock=now,reorg=false;
  const values:any={eventCount:4,liquidity:10_000_000n,eliminationOrder:[0,1,2,3],factors:[{scope:3,values:[0n,0n,0n,10_000_000n]}],collateralDecimals:6,collateral:pilotCash,funded:true,resolved:false,closesAt:BigInt(f.manifest.publication.draft.closesAt)};
  const rpc=async(method:string,params:any[])=>{
    calls.push([method,params]);
    if(method==='eth_call'){
      const {functionName}=decodeFunctionData({abi:pilotPoolAbi,data:params[0].data});
      if(functionName==='quoteBuy'){
        if(values.failQuote)throw Error('RPC unavailable');
        return encodeFunctionResult({abi:pilotPoolAbi,functionName,result:250_001n});
      }
      return encodeFunctionResult({abi:pilotPoolAbi,functionName,result:values[functionName]});
    }
    return {hash:reorg?'0x'+'99'.repeat(32):hash};
  };
  const create=(custom=model)=>pairAnalytics({service:f.service,rpc,model:custom,now:()=>clock});
  return {f,values,calls,create,setClock:(v:number)=>{clock=v;},setReorg:()=>{reorg=true;},now};
}
test('adapter pins all reads to the verified pool/block and certifies the Rust result',async()=>{
  const f=setup(),result=await f.create()({a:0,b:1});
  assert.equal(result.pool,f.f.manifest.pool);assert.equal(result.snapshot.blockHash,hash);
  assert.deepEqual(result.values,fixtures.find((x:any)=>x.name==='positive-relationship').displayed);
  for(const [method,params] of f.calls){assert.ok(['eth_call','eth_getBlockByNumber'].includes(method));if(method==='eth_call'){assert.equal(params[1],'0x64');assert.equal(params[0].to,result.pool);}}
});
test('adapter rejects changed bindings, stale blocks, settled pools and numerical disagreement',async()=>{
  for(const [key,value] of Object.entries({eventCount:3,collateralDecimals:18,collateral:'0x'+'99'.repeat(20),funded:false,resolved:true,closesAt:0n})){
    const f=setup();f.values[key]=value;await assert.rejects(f.create()({a:0,b:1}));
  }
  const reorg=setup();reorg.setReorg();await assert.rejects(reorg.create()({a:0,b:1}));
  const stale=setup();stale.setClock(stale.now+60);await assert.rejects(stale.create()({a:0,b:1}));
  const wrong=setup();await assert.rejects(wrong.create(async()=>({a:0,b:0,joint:0,givenYes:0,givenNo:0,independent:0,difference:0}))({a:0,b:1}));
  const chain=setup();chain.f.options.chain=1n;await assert.rejects(chain.create()({a:0,b:1}));
});
test('adapter deduplicates concurrent identical reads and rejects other work while busy',async()=>{
  const f=setup();let release!:()=>void,started!:()=>void;
  const ready=new Promise<void>(r=>{started=r;}),gate=new Promise<void>(r=>{release=r;});
  let runs=0;
  const analytics=f.create(async input=>{runs++;started();await gate;return model(input);});
  const first=analytics({a:0,b:1}),second=analytics({a:0,b:1});await ready;
  await assert.rejects(analytics({a:0,b:2}),/busy/);release();
  assert.deepEqual(await first,await second);assert.equal(runs,3); // Base plus two independent hypothetical states.
  await assert.rejects(analytics({a:0,b:1,trade:true}));
});

test('one-share sensitivity uses exact scope ordering, merges factors and leaves its input unchanged',()=>{
  const state={events:4,a:3,b:1,liquidity:'10000000',order:[0,1,2,3],
    factors:[{scope:10,values:['1','2','3','4']},{scope:10,values:['10','20','30','40']}]};
  const original=JSON.stringify(state),yes=simulatePairPurchase(state,'yes'),no=simulatePairPurchase(state,'no');
  assert.equal(yes.scope,10);assert.equal(yes.mask,8);assert.equal(no.mask,2);
  assert.deepEqual(yes.after.factors,[{scope:10,values:['11','22','33','1000044']}]);
  assert.deepEqual(no.after.factors,[{scope:10,values:['11','1000022','33','44']}]);
  assert.equal(JSON.stringify(state),original);
  assert.equal(simulatePairPurchase({...state,a:1,b:3},'no').mask,4);
  assert.throws(()=>simulatePairPurchase({...state,liquidity:'999999'},'yes'));
  const chain={...state,a:0,b:3,factors:[3,6,12].map(scope=>({scope,values:['0','0','0','1']}))};
  // A K4 graph is outside width two even though the requested claim has only two legs.
  assert.throws(()=>simulatePairPurchase({...chain,factors:[3,5,6,10,12].map(scope=>({scope,values:['0','0','0','1']}))},'yes'));
});

test('sensitivity agrees with independent closed-form tilting of a uniform distribution',()=>{
  const state={events:4,a:0,b:2,liquidity:'10000000',order:[0,1,2,3],factors:[]};
  for(const answer of ['yes','no']){
    const after=certifiedPair(simulatePairPurchase(state,answer).after).values;
    const t=Math.exp(0.1),z=3+t;
    const pA=answer==='yes'?(1+t)/z:2/z,pB=(1+t)/z;
    assert.equal(after.a,Math.round(1000*pA));assert.equal(after.b,Math.round(1000*pB));
    assert.equal(after.givenYes,Math.round(1000*(answer==='yes'?t:1)/(1+t)));
    assert.equal(after.givenNo,500);
    assert.equal(after.difference,Math.round(1000*((answer==='yes'?t:1)/z-pA*pB)));
  }
});

test('sensitivity quotes both independent scenarios at the original block and respects failure/close',async()=>{
  const f=setup(),result=await f.create()({a:0,b:1});
  assert.deepEqual(result.sensitivity.scenarios.map((s:any)=>[s.answer,s.status,s.costAtoms,s.quantityAtoms]),
    [['yes','available','250001','1000000'],['no','available','250001','1000000']]);
  for(const s of result.sensitivity.scenarios){
    const source={...fixtures.find((x:any)=>x.name==='positive-relationship').state};
    assert.deepEqual(s.values,certifiedPair(simulatePairPurchase(source,s.answer).after).values);
  }
  const quotes=f.calls.filter(([m,p]:any)=>m==='eth_call'&&decodeFunctionData({abi:pilotPoolAbi,data:p[0].data}).functionName==='quoteBuy');
  assert.equal(quotes.length,2);assert.ok(quotes.every(([,p]:any)=>p[1]==='0x64'));
  const unavailable=setup();unavailable.values.failQuote=true;
  const partial=await unavailable.create()({a:0,b:1});
  assert.equal(partial.values.a,result.values.a);
  assert.ok(partial.sensitivity.scenarios.every((s:any)=>s.reason==='quote_unavailable'&&s.values===undefined));
  const closed=setup();closed.values.closesAt=BigInt(closed.now);
  closed.f.manifest.publication.draft.closesAt=closed.now;
  const historical=await closed.create()({a:0,b:1});
  assert.ok(historical.sensitivity.scenarios.every((s:any)=>s.reason==='market_closed'));
});
test('analytics API requires passkey auth, same origin, exact pair input and sanitizes errors',async()=>{
  let logged=false,calls=0,fail=false;
  const manifest=pilotFixture().manifest;
  const api=localApi({store:{read:async()=>logged?{method:'passkey'}:null},pilot:{manifest,analytics:async()=>{calls++;if(fail)throw Error('private upstream');return {ok:true};}}});
  async function request(input:any,origin='http://localhost:18767'){
    const req:any={url:'/api/pilot/analytics',method:'POST',headers:{host:'localhost:18767',origin,'content-type':'application/json'},async *[Symbol.asyncIterator](){yield JSON.stringify(input);}};
    let status=0,body:any;const res:any={writeHead:(v:number)=>{status=v;},end:(v:string)=>{body=JSON.parse(v);},setHeader:()=>{}};
    await api(req,res,()=>{});return {status,body};
  }
  assert.equal((await request({a:0,b:1})).status,401);logged=true;
  assert.equal((await request({a:0,b:1},'https://other.example')).status,403);
  for(const bad of [null,[],{a:0,b:0},{a:0,b:2},{a:0,b:1,to:'wallet'}])assert.equal((await request(bad)).status,400);
  assert.equal(calls,0);assert.equal((await request({a:0,b:1})).status,200);
  fail=true;const result=await request({a:0,b:1});assert.equal(result.status,503);assert.ok(!JSON.stringify(result).includes('private upstream'));
});
