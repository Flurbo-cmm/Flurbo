import assert from 'node:assert/strict';
import {test} from 'node:test';
import {decodeFunctionData,encodeFunctionResult} from 'viem';
import {claimAnalytics} from '../server/claim-analytics.mjs';
import {pilotPoolAbi,pilotCash} from '../shared/pilot.mjs';
import {poolFixture,hash} from './pool-fixture.ts';
import {certifiedClaim} from '../server/pair-math.mjs';
import {depthRateWad,lsAnalyticsState} from '../shared/ls-lmsr.mjs';

function setup(){
  const f=poolFixture(Math.floor(Date.now()/1000),4),now=Math.floor(Date.now()/1000),calls:any[]=[];
  const values:any={eventCount:4,liquidity:10_000_000n,eliminationOrder:[0,1,2,3],factors:[],collateralDecimals:6,collateral:pilotCash,funded:true,resolved:false,closesAt:BigInt(f.manifest.publication.draft.closesAt)};
  let reorg=false,clock=now;
  const rpc=async(method:string,params:any[])=>{
    calls.push([method,params]);
    if(method==='eth_call'){const {functionName}=decodeFunctionData({abi:pilotPoolAbi,data:params[0].data});return encodeFunctionResult({abi:pilotPoolAbi,functionName,result:values[functionName]});}
    return {hash:reorg?'0x'+'99'.repeat(32):hash};
  };
  return {f,values,calls,rpc,run:claimAnalytics({service:f.service,rpc,now:()=>clock}),reorg:()=>{reorg=true;},stale:()=>{clock+=61;}};
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
function lsSetup(){
  const s=setup();
  const input={events:4,a:0,b:1,initialDepthAtoms:'10000000',commissionBps:500,order:[0,1,2,3],factors:[{scope:3,values:['0','0','0','10000000']}]};
  const expected=lsAnalyticsState(input);
  s.f.manifest.publication.pricing={model:'ls-lmsr.v1',initialDepthAtoms:'10000000',commissionBps:500,depthRateWad:depthRateWad(4,500).toString()};
  Object.assign(s.values,{factors:[{scope:3,values:[0n,0n,0n,10_000_000n]}],depth:expected.depthWad,commissionBps:500});
  return {...s,expected,run:claimAnalytics({service:s.f.service,rpc:s.rpc,now:()=>Math.floor(Date.now()/1000)})};
}
test('LS pools: claim analytics reads depth, cross-checks it and reports the LS model',async()=>{
  const s=lsSetup(),result=await s.run({scope:7,mask:'22'});
  assert.equal(result.model,'bounded-ls-lmsr-enumeration-v1');
  assert.deepEqual(result.values,certifiedClaim(s.expected.state,7,'22').values);
  const names=s.calls.filter(([m]:any)=>m==='eth_call').map(([,p]:any)=>decodeFunctionData({abi:pilotPoolAbi,data:p[0].data}).functionName);
  assert.ok(names.includes('depth')&&names.includes('commissionBps'));
});
test('LS pools: a claim depth that differs from the formula fails closed',async()=>{
  for(const change of [{depth:1n},{depth:-1n},{commissionBps:2000},{liquidity:11_000_000n}]){
    const s=lsSetup();
    for(const [key,value] of Object.entries(change))s.values[key]=key==='depth'?s.values.depth+(value as bigint):value;
    await assert.rejects(s.run({scope:7,mask:'22'}),/Unsupported analytics pool/);
  }
});
