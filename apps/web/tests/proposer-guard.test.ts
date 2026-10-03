import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {decodeFunctionData,encodeFunctionResult,parseAbi} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {pilotPoolAbi} from '../shared/pilot.mjs';
import {claimMasks,proposerHoldings} from '../server/proposer-guard.mjs';
import {resolutionTick} from '../server/resolution-worker.mjs';
import {monitorIdentity} from '../server/settlement-monitor.mjs';
import {pilotFixture} from './pilot-fixture.ts';

const multicall=parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)']);
const erc20=parseAbi(['function balanceOf(address) view returns (uint256)']);
const pool='0x'+'22'.repeat(20),token='0x'+'7e'.repeat(20),proposer='0x'+'12'.repeat(20);

function chain({scopes=[1,6,7],held={} as Record<string,bigint>,wrapped=0n,fail=false}={}){
  const calls:any[]=[];
  const rpc=async(method:string,params:any[])=>{
    if(method==='eth_getBlockByNumber')return {number:'0x64',hash:'0x'+'44'.repeat(32)};
    assert.equal(params[1],'0x64','every read is pinned to one block');
    const inner=decodeFunctionData({abi:multicall,data:params[0].data}).args[0] as any[];calls.push(inner.length);
    if(fail)throw Error('RPC outage');
    return encodeFunctionResult({abi:multicall,functionName:'aggregate3',result:inner.map(c=>{
      if(c.target.toLowerCase()===token)return {success:true,returnData:encodeFunctionResult({abi:erc20,functionName:'balanceOf',result:wrapped})};
      const {functionName,args}=decodeFunctionData({abi:pilotPoolAbi,data:c.callData}) as any;
      const result=functionName==='factors'?scopes.map(scope=>({scope,values:[0n]}))
        :functionName==='baseTokens'?(args[0]===1&&args[1]===2?token:'0x'+'00'.repeat(20))
        :held[`${args[1]}:${args[2]}`]??0n;
      return {success:true,returnData:encodeFunctionResult({abi:pilotPoolAbi,functionName,result} as any)};
    })});
  };
  return {rpc,calls,manifest:{pool,publication:{draft:{events:[{},{},{}]}}}};
}

test('mask enumeration matches the contract claim key for one, two and three event scopes',()=>{
  assert.equal(claimMasks(1).length,2);assert.equal(claimMasks(6).length,14);assert.equal(claimMasks(7).length,254);
  assert.deepEqual([claimMasks(7)[0],claimMasks(7).at(-1)],[1,254]);
  assert.throws(()=>claimMasks(15),/Unsupported/);assert.throws(()=>claimMasks(0),/Unsupported/);
});

test('guard checks every factor-scope claim and wrapped base token at one block, in bounded chunks',async()=>{
  const clean=chain();
  const ok=await proposerHoldings({manifest:clean.manifest,rpc:clean.rpc,owner:proposer});
  assert.equal(ok.clear,true);assert.equal(ok.checkedClaims,270);assert.equal(ok.checkedTokens,1);
  assert.ok(clean.calls.every(n=>n<=250),'multicall chunks stay bounded');
  const combo=chain({held:{'7:200':3n}});
  const found=await proposerHoldings({manifest:combo.manifest,rpc:combo.rpc,owner:proposer});
  assert.equal(found.clear,false);assert.deepEqual(found.positions,[{scope:7,mask:200,quantity:'3'}]);
  const wrapped=chain({wrapped:1n});
  const w=await proposerHoldings({manifest:wrapped.manifest,rpc:wrapped.rpc,owner:proposer});
  assert.equal(w.clear,false);assert.deepEqual(w.wrapped,[{event:0,outcome:'YES',token,balance:'1'}]);
  await assert.rejects(proposerHoldings({manifest:clean.manifest,rpc:chain({fail:true}).rpc,owner:proposer}),/outage/);
  await assert.rejects(proposerHoldings({manifest:clean.manifest,rpc:clean.rpc,owner:'bot'}),/Invalid proposer/);
});

const account=privateKeyToAccount(('0x'+'12'.repeat(32)) as `0x${string}`),owner=account.address.toLowerCase(),now=1800000000;
function setup(){
  const f=pilotFixture(now);f.manifest.publication.draft.closesAt=now-100;
  f.manifest.publication.draft.events.forEach((e:any)=>e.observationEndsAt=now-10);
  const data=new Map<string,string>();
  const command=async(op:string,...a:any[])=>{
    if(op==='GET')return data.get(a[0])??null;
    if(op==='SET'){if(a.includes('NX')&&data.has(a[0]))return null;data.set(a[0],a[1]);return 'OK';}
    if(op==='EVAL'){const [,,lock,key,tk,mode,body]=a;if(data.get(lock)!==tk)return 0;if(mode==='release')data.delete(lock);if(mode==='save')data.set(key,body);return 1;}
    throw Error('Unexpected store call');
  };
  data.set('flurbo:monitor:v1:'+createHash('sha256').update(monitorIdentity(f.manifest)).digest('hex')+':state',
    JSON.stringify({checkpoint:{identity:monitorIdentity(f.manifest),checkedAt:now},report:{status:'observed'},queue:[]}));
  let signed=0,evidenceCalls=0;
  const transport={sign:async(review:any)=>{signed++;return account.signTransaction({chainId:10143,type:'legacy',nonce:0,to:review.transaction.to,data:review.transaction.data,value:0n,gas:BigInt(review.gasLimit),gasPrice:BigInt(review.gasPrice)});},broadcast:async()=>{},receipt:async()=>({confirmed:true,success:true})};
  const options={manifest:f.manifest,owner,service:f.service,command,transport,enabled:true,now:()=>now,
    evidence:async()=>{evidenceCalls++;return {outcome:2,hash:'0x'+'ab'.repeat(32),uri:'https://flurbo.singu.online/api/pilot/evidence/fixture'};}};
  return {f,options,counts:()=>({signed,evidenceCalls})};
}
const clear=async()=>({clear:true,positions:[],wrapped:[],blockNumber:'100',checkedClaims:2});
const holding=async()=>({clear:false,positions:[{scope:1,mask:1,quantity:'4'}],wrapped:[],blockNumber:'100'});

test('a proposer holding any position, or an unavailable guard, blocks proposals before evidence or signing',async()=>{
  for(const [guard,status] of [[holding,'holds-position'],[undefined,'guard-missing'],[async()=>{throw Error('RPC outage');},'guard-unavailable'],
    [async()=>({clear:true,positions:[{scope:1,mask:1,quantity:'1'}],wrapped:[]}),'holds-position']] as const){
    const s=setup(),result=await resolutionTick({...s.options,proposerHoldings:guard as any});
    assert.equal(result.status,'proposer-blocked');assert.equal(result.proposer.status,status);
    assert.deepEqual(s.counts(),{signed:0,evidenceCalls:0});
  }
  const s=setup(),dry=await resolutionTick({...s.options,enabled:false,proposerHoldings:holding});
  assert.equal(dry.status,'dry-run');assert.equal(dry.proposer.status,'holds-position');
});

test('the guard is re-read before signing; a position acquired after evidence still blocks the proposal',async()=>{
  const s=setup();s.f.options.allowance=1000000n;let reads=0;
  const flips=async()=>(++reads===1?clear():holding());
  const result=await resolutionTick({...s.options,proposerHoldings:flips});
  assert.equal(result.status,'proposer-blocked');assert.equal(reads,2);
  assert.deepEqual(s.counts(),{signed:0,evidenceCalls:1});
  const ok=setup();ok.f.options.allowance=1000000n;
  assert.equal((await resolutionTick({...ok.options,proposerHoldings:clear})).action,'assertOutcome');
});

test('finishing actions do not depend on proposer holdings',async()=>{
  const s=setup(),state=await s.f.service.status();state.cases.forEach((c:any)=>c.assertionDeadline=String(now-1));
  const result=await resolutionTick({...s.options,service:{status:async()=>state,prepare:s.f.service.prepare},proposerHoldings:holding,
    evidence:async()=>{assert.fail('Finishing must not gather evidence');}});
  assert.equal(result.status,'submitted');assert.equal(result.action,'finalize');
});

test('worker preflight reports a proposer position while waiting, before any proposal is possible',async()=>{
  const {proposalMode}=await import('../scripts/run-resolution.mjs');
  assert.equal(proposalMode({}),false);assert.equal(proposalMode({FLURBO_RESOLUTION_PROPOSALS:''}),false);
  assert.equal(proposalMode({FLURBO_RESOLUTION_PROPOSALS:'false'}),false);assert.equal(proposalMode({FLURBO_RESOLUTION_PROPOSALS:'true'}),true);
  assert.throws(()=>proposalMode({FLURBO_RESOLUTION_PROPOSALS:'yes'}),/Invalid proposal mode/);
  const s=setup(),early=await s.f.service.status();
  early.manifest.publication.draft.events.forEach((e:any)=>e.observationEndsAt=now+3600);early.cases.forEach((c:any)=>c.assertionDeadline=String(now+7200));
  const waiting={...s.options,service:{status:async()=>structuredClone(early),prepare:async()=>assert.fail('No action while waiting')}};
  const live=await resolutionTick({...waiting,proposerHoldings:holding,preflight:true});
  assert.equal(live.status,'wait');assert.equal(live.proposerPreflight.status,'holds-position');
  const dry=await resolutionTick({...waiting,enabled:false,proposerHoldings:holding,preflight:true});
  assert.equal(dry.proposerPreflight.status,'holds-position');
  assert.equal((await resolutionTick({...waiting,proposerHoldings:holding})).proposerPreflight,undefined,'preflight is opt-in per pool');
  // Proposals disabled (allowEvidence false): evidence is never gathered, but the preflight still reports.
  const inWindow=await s.f.service.status();
  const off=await resolutionTick({...s.options,allowEvidence:false,preflight:true,proposerHoldings:clear,
    service:{status:async()=>structuredClone(inWindow),prepare:async()=>assert.fail('Proposals are disabled')},evidence:async()=>assert.fail('Proposals are disabled')});
  assert.equal(off.status,'wait');assert.equal(off.proposerPreflight.status,'clear');assert.deepEqual(s.counts(),{signed:0,evidenceCalls:0});
});
