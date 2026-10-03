import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData,encodeFunctionResult } from 'viem';
import { checkMockReadiness } from '../server/mock-readiness.mjs';
import { runMockReadiness } from '../scripts/check-mock-readiness.mjs';
import { runPairModel } from '../server/pair-analytics.mjs';
import { pilotPoolAbi,pilotCash } from '../shared/pilot.mjs';
import { pilotFixture } from './pilot-fixture.ts';
import { rustExample } from './rust-example.ts';

function fixture(){
  const now=1_800_000_000,f=pilotFixture(now,4),namespace='practice-'+f.manifest.pool.slice(2);
  f.manifest.publication.mode='rehearsal';
  const values:any={eventCount:4,liquidity:10000000n,eliminationOrder:[0,1,2,3],factors:[],collateralDecimals:6,collateral:pilotCash,funded:true,resolved:false,closesAt:BigInt(f.manifest.publication.draft.closesAt)};
  const health:any={service:'flurbo',chain_state:'not_checked',practice_collections:{active:namespace,configured:[{namespace,pool:f.manifest.pool,rulesHash:f.manifest.rulesHash,closesAt:Number(values.closesAt)}]}};
  const calls:string[]=[];let guard=401;
  const request=async(url:string,options:any)=>{
    assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.ok(!options.headers.Cookie);
    const path=new URL(url).pathname;calls.push(path);
    if(path==='/healthz')return Response.json(health);
    if(path.startsWith('/api/')){if(options.method==='POST')assert.equal(options.headers.Origin,'https://flurbo.singu.online');return Response.json({}, {status:guard});}
    return new Response('<html>Flurbo</html>',{headers:{'content-type':'text/html','content-security-policy':"frame-ancestors 'none'",'cache-control':'no-store'}});
  };
  const rpc=async(method:string,params:any[])=>{
    assert.ok(['eth_chainId','eth_getBlockByNumber','eth_getCode','eth_call'].includes(method));
    if(method==='eth_call'){
      assert.equal(params[0].from,undefined);
      try{const {functionName}=decodeFunctionData({abi:pilotPoolAbi,data:params[0].data});
        if(functionName in values)return encodeFunctionResult({abi:pilotPoolAbi,functionName,result:values[functionName]});
      }catch{}
    }
    return f.rpc(method,params);
  };
  return {health,values,calls,setGuard:(value:number)=>{guard=value;},options:{manifest:f.manifest,namespace,featured:true,request,rpc,now:()=>now,model:(input:string)=>runPairModel(input,{file:rustExample('pair_analytics')})}};
}
test('readiness checks October identity, guarded routes, quotes and certified analytics without signing',async()=>{
  const f=fixture(),report=await checkMockReadiness(f.options);
  assert.equal(report.status,'ready_for_manual_trading_checks');assert.equal(report.checks.length,5);
  assert.equal(report.checks[3].details.quotes.length,4);assert.equal(report.checks[4].details.scenarios.length,2);
  assert.equal(report.checks[4].details.values.joint,250);assert.equal(report.checks[4].details.values.independent,250);
  assert.match(report.notice,/not end-to-end/);assert.ok(f.calls.includes('/api/'+f.options.namespace+'/analytics'));
});
test('configured but non-featured, absent or mismatched metadata cannot pass October acceptance',async()=>{
  for(const change of [(h:any)=>{h.practice_collections.active='rehearsal';},(h:any)=>{delete h.practice_collections;},(h:any)=>{h.practice_collections.configured[0].rulesHash='wrong';}]){
    const f=fixture();change(f.health);const report=await checkMockReadiness(f.options);
    assert.equal(report.status,'attention_required');assert.equal(report.checks[0].status,'fail');
  }
});
test('unguarded routes and settled pools fail acceptance; infrastructure errors disclose no endpoint credentials',async()=>{
  const f=fixture();f.setGuard(200);f.values.resolved=true;
  const report=await checkMockReadiness(f.options);assert.equal(report.checks[1].status,'fail');assert.equal(report.checks[3].status,'fail');assert.equal(report.checks[4].status,'fail');
  const failed=await checkMockReadiness({...fixture().options,request:async()=>{throw Error('secret-rpc-credential');},rpc:async()=>{throw Error('secret-rpc-credential');}});
  assert.equal(failed.status,'attention_required');assert.ok(!JSON.stringify(failed).includes('secret-rpc-credential'));
});
test('unknown modes and collection bindings reject before any network access',async()=>{
  await assert.rejects(runMockReadiness({args:['--unknown']}));
  const f=fixture();await assert.rejects(checkMockReadiness({...f.options,namespace:'practice-'+'ab'.repeat(20)}));assert.equal(f.calls.length,0);
});
