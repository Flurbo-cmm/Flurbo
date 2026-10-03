import assert from 'node:assert/strict';
import {test} from 'node:test';
import {decodeFunctionData,encodeFunctionResult} from 'viem';
import {claimAnalytics} from '../server/claim-analytics.mjs';
import {pilotPoolAbi,pilotCash} from '../shared/pilot.mjs';
import {pilotFixture,hash} from './pilot-fixture.ts';
import {localApi} from '../server/local-api.mjs';

function setup(){
  const f=pilotFixture(Math.floor(Date.now()/1000),4),now=Math.floor(Date.now()/1000),calls:any[]=[];
  const values:any={eventCount:4,liquidity:10_000_000n,eliminationOrder:[0,1,2,3],factors:[],collateralDecimals:6,collateral:pilotCash,funded:true,resolved:false,closesAt:BigInt(f.manifest.publication.draft.closesAt)};
  let reorg=false,clock=now;
  const rpc=async(method:string,params:any[])=>{
    calls.push([method,params]);
    if(method==='eth_call'){const {functionName}=decodeFunctionData({abi:pilotPoolAbi,data:params[0].data});return encodeFunctionResult({abi:pilotPoolAbi,functionName,result:values[functionName]});}
    return {hash:reorg?'0x'+'99'.repeat(32):hash};
  };
  return {f,values,calls,run:claimAnalytics({service:f.service,rpc,now:()=>clock}),reorg:()=>{reorg=true;},stale:()=>{clock+=61;}};
}
test('claim analysis reads one verified snapshot, contains identity and never quotes or sends trades',async()=>{
  const s=setup(),result=await s.run({scope:7,mask:'22'});
  assert.deepEqual(result.values,{market:375,independent:375,difference:0});
  assert.equal(result.pool,s.f.manifest.pool);assert.equal(result.mask,'22');assert.equal(result.schema,'flurbo.claim-analytics.v1');
  for(const [method,params] of s.calls){assert.ok(['eth_call','eth_getBlockByNumber'].includes(method));if(method==='eth_call'){assert.equal(params[0].to,result.pool);assert.equal(params[1],'0x64');}}
});
test('claim analysis rejects wrong bindings, settled state, stale/reorg data and unsupported claims',async()=>{
  for(const [key,value] of Object.entries({eventCount:3,collateralDecimals:18,funded:false,resolved:true,closesAt:0n,collateral:'0x'+'99'.repeat(20)})){
    const s=setup();s.values[key]=value;await assert.rejects(s.run({scope:3,mask:'14'}));
  }
  for(const bad of [null,[],{scope:15,mask:'1'},{scope:3,mask:'15'},{scope:3,mask:14},{scope:3,mask:'14',pool:'other'}])await assert.rejects(setup().run(bad));
  const r=setup();r.reorg();await assert.rejects(r.run({scope:3,mask:'14'}));
  const s=setup();s.stale();await assert.rejects(s.run({scope:3,mask:'14'}));
  const chain=setup();chain.f.options.chain=1n;await assert.rejects(chain.run({scope:3,mask:'14'}));
});
test('claim API preserves login, invite and origin gates, rejects ambiguous input and hides upstream errors',async()=>{
  let logged=false,approved=false,calls=0,fail=false;
  const api=localApi({previewAccess:{allows:()=>approved},store:{read:async()=>logged?{method:'passkey',address:'0x'+'99'.repeat(20)}:null},pilot:{manifest:pilotFixture().manifest,claimAnalytics:async()=>{calls++;if(fail)throw Error('sensitive provider detail');return {ok:true};}}});
  async function request(input:any,origin='http://localhost:18767'){
    const req:any={url:'/api/pilot/claim-analytics',method:'POST',headers:{host:'localhost:18767',origin,'content-type':'application/json'},async *[Symbol.asyncIterator](){yield JSON.stringify(input);}};
    let status=0,body:any;const res:any={writeHead:(v:number)=>{status=v;},end:(v:string)=>{body=JSON.parse(v);},setHeader:()=>{}};
    await api(req,res,()=>{});return {status,body};
  }
  assert.equal((await request({scope:3,mask:'14'})).status,401);logged=true;
  assert.equal((await request({scope:3,mask:'14'})).status,403);approved=true;
  assert.equal((await request({scope:3,mask:'14'},'https://other.example')).status,403);
  for(const bad of [null,[],{scope:3,mask:'15'},{scope:4,mask:'1'},{scope:3,mask:'14',to:'wallet'}])assert.equal((await request(bad)).status,400);
  assert.equal(calls,0);assert.equal((await request({scope:3,mask:'14'})).status,200);
  fail=true;const result=await request({scope:3,mask:'14'});assert.equal(result.status,503);assert.ok(!JSON.stringify(result).includes('sensitive'));
});
