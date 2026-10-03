import assert from 'node:assert/strict';
import {test} from 'node:test';
import {decodeFunctionData,encodeFunctionResult} from 'viem';
import {thesisAnalytics} from '../server/thesis-analytics.mjs';
import {pilotPoolAbi,pilotCash} from '../shared/pilot.mjs';
import {pilotFixture,hash} from './pilot-fixture.ts';
import {localApi} from '../server/local-api.mjs';
import {validateThesisSnapshot} from '../src/thesis.ts';

const input={a:0,b:1,yesA:true,yesB:true,quantity:'1000000'};
function setup(){
  const now=Math.floor(Date.now()/1000),f=pilotFixture(now,4),calls:any[]=[];
  const values:any={eventCount:4,liquidity:10_000_000n,eliminationOrder:[0,1,2,3],factors:[],collateralDecimals:6,collateral:pilotCash,funded:true,resolved:false,closesAt:BigInt(f.manifest.publication.draft.closesAt)};
  let reorg=false,clock=now,failQuotes=false,release:(()=>void)|null=null,gate:Promise<void>|null=null;
  const rpc=async(method:string,params:any[])=>{
    calls.push([method,params]);if(gate)await gate;
    if(method==='eth_call'){
      const {functionName,args}=decodeFunctionData({abi:pilotPoolAbi,data:params[0].data});
      if(functionName==='quoteBuy'){
        if(failQuotes)throw Error('sensitive provider error');
        // Distinct prices ensure no accidental use of the allowance or probability as cost.
        const quantity=BigInt(String(args![2])),mask=String(args![1]);
        return encodeFunctionResult({abi:pilotPoolAbi,functionName,result:quantity*(mask==='8'?26n:mask==='14'?76n:52n)/100n});
      }
      return encodeFunctionResult({abi:pilotPoolAbi,functionName,result:values[functionName]});
    }
    return {hash:reorg?'0x'+'99'.repeat(32):hash};
  };
  return {f,values,calls,now,run:thesisAnalytics({service:f.service,rpc,now:()=>clock}),reorg:()=>{reorg=true;},clock:(v:number)=>{clock=v;},failQuotes:()=>{failQuotes=true;},hold:()=>{gate=new Promise<void>(r=>{release=r;});},release:()=>{release?.();gate=null;}};
}
test('all probabilities and size quotes share one bound verified block; conditional orientation is B given A',async()=>{
  const s=setup(),result=await s.run(input);
  assert.deepEqual(result.pair.values,{a:500,b:500,joint:250,givenYes:500,givenNo:500,independent:250,difference:0});
  assert.deepEqual(result.scenarios,[250,250,250,250]);assert.deepEqual(result.candidates.map((c:any)=>c.probability),[500,250,750,500]);
  assert.deepEqual(result.candidates.map((c:any)=>c.costAtoms),['520000','260000','760000','520000']);
  assert.equal(result.candidates[1].maxSpendAtoms,'261300');assert.equal(validateThesisSnapshot(result,s.f.manifest,input).pool,s.f.manifest.pool);
  assert.deepEqual(result.eventIds,['event-0','event-1']);
  for(const [method,params] of s.calls){assert.ok(['eth_call','eth_getBlockByNumber'].includes(method));if(method==='eth_call'){assert.equal(params[0].to,result.pool);assert.equal(params[1],'0x64');assert.equal(params[0].from,undefined);}}
  assert.equal(s.calls.filter(([method,params])=>method==='eth_call'&&decodeFunctionData({abi:pilotPoolAbi,data:params[0].data}).functionName==='quoteBuy').length,4);
  s.values.factors=[{scope:1,values:[0n,10_000_000n]}];const skewed=await s.run(input);
  assert.equal(skewed.pair.values.b,731);assert.equal(skewed.pair.values.a,500);assert.equal(skewed.pair.values.givenYes,500);
});
test('closing, unavailable and oversized quotes preserve exploration and never send a transaction',async()=>{
  const closed=setup();closed.values.resolved=true;const result=await closed.run(input);
  assert.ok(result.closed);assert.equal(result.candidates[1].probability,250);assert.ok(result.candidates.every((c:any)=>c.costAtoms===null&&c.reason==='market_closed'));
  assert.ok(closed.calls.every(([m,p])=>m!=='eth_call'||decodeFunctionData({abi:pilotPoolAbi,data:p[0].data}).functionName!=='quoteBuy'));
  const s=setup();s.failQuotes();const bad=await s.run(input);assert.ok(bad.candidates.every((c:any)=>c.costAtoms===null&&c.reason==='quote_unavailable'));assert.ok(!JSON.stringify(bad).includes('sensitive'));
  const over=await setup().run({...input,quantity:'12000000'});assert.equal(over.maxTradeQuantityAtoms,'10000000');assert.ok(over.candidates.every((c:any)=>c.reason==='quantity_limit'));
});
test('rejects changed identity, stale/reorg data and forged frontend payloads',async()=>{
  for(const [key,value] of Object.entries({eventCount:3,collateralDecimals:18,funded:false,closesAt:0n,collateral:'0x'+'99'.repeat(20)})){
    const s=setup();s.values[key]=value;await assert.rejects(s.run(input));
  }
  const r=setup();r.reorg();await assert.rejects(r.run(input));const s=setup();s.clock(s.now+61);await assert.rejects(s.run(input));
  const chain=setup();chain.f.options.chain=1n;await assert.rejects(chain.run(input));
  const valid=setup(),result=await valid.run(input);
  for(const field of ['pool','rulesHash','eventIds','input','expiresAt','candidates']){
    const bad=structuredClone(result);if(field==='candidates')bad.candidates[1].mask='14';else if(field==='eventIds')bad.eventIds.reverse();else if(field==='input')bad.input.quantity='2000000';else (bad as any)[field]='wrong';
    assert.throws(()=>validateThesisSnapshot(bad,valid.f.manifest,input));
  }
  const price=structuredClone(result);price.candidates[0].maxSpendAtoms='1';assert.throws(()=>validateThesisSnapshot(price,valid.f.manifest,input));
  assert.throws(()=>validateThesisSnapshot(result,valid.f.manifest,input,result.expiresAt));
});
test('identical concurrent reads coalesce, different comparisons are bounded until completion',async()=>{
  const s=setup();s.hold();const first=s.run(input),second=s.run({...input});await assert.rejects(s.run({...input,b:2}),/busy/);
  s.release();const [a,b]=await Promise.all([first,second]);assert.deepEqual(a,b);
  assert.equal(s.calls.filter(([m])=>m==='eth_getBlockByNumber').length,1);
  assert.equal((await s.run({...input,b:2})).input.b,2);
});
test('thesis API keeps authentication, invite and origin gates and refuses arbitrary payloads',async()=>{
  let logged=false,approved=false,calls=0,fail=false;
  const api=localApi({previewAccess:{allows:()=>approved},store:{read:async()=>logged?{method:'passkey',address:'0x'+'99'.repeat(20)}:null},pilot:{manifest:pilotFixture().manifest,thesisAnalytics:async()=>{calls++;if(fail)throw Error('sensitive provider detail');return {ok:true};}}});
  async function request(body:any,origin='http://localhost:18767'){
    const req:any={url:'/api/pilot/thesis',method:'POST',headers:{host:'localhost:18767',origin,'content-type':'application/json'},async *[Symbol.asyncIterator](){yield JSON.stringify(body);}};
    let status=0,json:any;const res:any={writeHead:(v:number)=>{status=v;},end:(v:string)=>{json=JSON.parse(v);},setHeader:()=>{}};
    await api(req,res,()=>{});return {status,json};
  }
  assert.equal((await request(input)).status,401);logged=true;assert.equal((await request(input)).status,403);approved=true;
  assert.equal((await request(input,'https://other.example')).status,403);
  for(const bad of [null,[],{...input,note:'personal'},{...input,a:input.b},{...input,quantity:'0'}])assert.equal((await request(bad)).status,400);
  assert.equal(calls,0);assert.equal((await request(input)).status,200);fail=true;const failed=await request(input);assert.equal(failed.status,503);assert.ok(!JSON.stringify(failed).includes('sensitive'));
});
