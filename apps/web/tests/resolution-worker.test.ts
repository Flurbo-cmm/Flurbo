import {test} from 'node:test';
import assert from 'node:assert/strict';
import {privateKeyToAccount} from 'viem/accounts';
import {createHash} from 'node:crypto';
import {pilotFixture} from './pilot-fixture.ts';
import {nextResolutionAction,resolutionTick,validateWorkerReview} from '../server/resolution-worker.mjs';
import {monitorIdentity} from '../server/settlement-monitor.mjs';
import {ACTIVITY_METRICS,activityEvent} from '../shared/ethereum-activity.mjs';
const account=privateKeyToAccount(('0x'+'12'.repeat(32)) as `0x${string}`),owner=account.address.toLowerCase(),now=1800000000;
const journalKey='flurbo:monitor:v1:'+createHash('sha256').update('resolution-worker-v1:'+owner).digest('hex')+':state';
function storage(manifest:any){
  const data=new Map<string,string>();
  const command=async(op:string,...a:any[])=>{
    if(op==='GET')return data.get(a[0])??null;
    if(op==='SET'){if(a.includes('NX')&&data.has(a[0]))return null;data.set(a[0],a[1]);return 'OK';}
    if(op==='EVAL'){const [,,lock,key,token,mode,body]=a;if(data.get(lock)!==token)return 0;if(mode==='release')data.delete(lock);if(mode==='save')data.set(key,body);return 1;}
    throw Error('Unexpected store call');
  };
  const key='flurbo:monitor:v1:'+createHash('sha256').update(monitorIdentity(manifest)).digest('hex')+':state';
  data.set(key,JSON.stringify({checkpoint:{identity:monitorIdentity(manifest),checkedAt:now},report:{status:'observed'},queue:[]}));
  return {data,command,monitorKey:key};
}
test('resolution planner respects deadlines, own assertions, disputes and collection-wide delivery',async()=>{
  const f=pilotFixture(now,4),s=await f.service.status();
  assert.equal(nextResolutionAction(s,owner).kind,'wait');
  s.snapshot.timestamp=now+90000;assert.deepEqual(nextResolutionAction(s,owner),{kind:'evidence',event:0});
  s.cases[0]={...s.cases[0],phase:1,proposal:2,asserter:owner,evidenceHash:'0x'+'ab'.repeat(32),challengeUntil:String(now+90000)};
  assert.equal(nextResolutionAction(s,owner).event,1);
  assert.deepEqual(nextResolutionAction(s,owner,{0:{outcome:2,evidenceHash:s.cases[0].evidenceHash}}),{kind:'transaction',action:'finalize',event:0});
  s.manifest.publication.mode='rehearsal';s.cases[0].phase=3;
  assert.equal(nextResolutionAction(s,owner).event,3); // never falsify the B dispute exercise or assert C
  s.cases.forEach(c=>c.phase=3);assert.equal(nextResolutionAction(s,owner).action,'deliver');
  s.delivered=true;assert.equal(nextResolutionAction(s,owner).kind,'complete');
});
test('worker journals before broadcast and reconciles an uncertain submission without duplicate signing',async()=>{
  const f=pilotFixture(now),s=await f.service.status();s.cases.forEach(c=>c.assertionDeadline=String(now-1));
  const db=storage(f.manifest);let signed=0,broadcast=0,confirmed=false,evidenceCalls=0;
  const transport={sign:async(review:any)=>{signed++;return account.signTransaction({chainId:10143,type:'legacy',nonce:0,to:review.transaction.to,data:review.transaction.data,value:0n,gas:BigInt(review.gasLimit),gasPrice:BigInt(review.gasPrice)});},
    broadcast:async()=>{broadcast++;assert.ok([...db.data.values()].some(v=>v.includes('"pending":{"hash"')));throw Error('Response lost after submission');},
    receipt:async()=>confirmed?{confirmed:true,success:true}:null};
  const options={manifest:f.manifest,owner,service:{status:async()=>s,prepare:f.service.prepare},command:db.command,transport,evidence:async()=>{evidenceCalls++;return null;},now:()=>now};
  assert.equal((await resolutionTick(options)).status,'dry-run');assert.equal(signed,0);
  await assert.rejects(resolutionTick({...options,enabled:true}),/Response lost/);assert.equal(signed,1);assert.equal(broadcast,1);
  assert.equal((await resolutionTick({...options,enabled:true})).status,'pending');assert.equal(signed,1);
  confirmed=true;assert.equal((await resolutionTick({...options,enabled:true})).status,'confirmed');assert.equal(signed,1);assert.equal(evidenceCalls,0);
});

test('restart rebroadcasts only identical journal bytes after an absent hash and exact unconsumed nonce',async()=>{
  const f=pilotFixture(now),s=await f.service.status();s.cases.forEach(c=>c.assertionDeadline=String(now-1));
  const db=storage(f.manifest);let at=now,signed=0;const raws:string[]=[];
  let retry={known:false,latestNonce:0,pendingNonce:0};
  const transport={sign:async(review:any)=>{signed++;return account.signTransaction({chainId:10143,type:'legacy',nonce:0,to:review.transaction.to,data:review.transaction.data,value:0n,gas:BigInt(review.gasLimit),gasPrice:BigInt(review.gasPrice)});},
    broadcast:async(raw:string)=>{raws.push(raw);if(raws.length===1)throw Error('Crash before RPC acceptance');},
    receipt:async()=>null,retryStatus:async()=>retry};
  const options={manifest:f.manifest,owner,service:{status:async()=>s,prepare:f.service.prepare},command:db.command,transport,enabled:true,now:()=>at};
  await assert.rejects(resolutionTick(options),/Crash/);
  assert.equal((await resolutionTick(options)).status,'pending');assert.equal(raws.length,1);
  at+=60;assert.equal((await resolutionTick(options)).status,'resubmitted');
  assert.equal(signed,1);assert.equal(raws[0],raws[1]);
  at+=60;retry={known:true,latestNonce:0,pendingNonce:1};
  assert.equal((await resolutionTick(options)).status,'pending');assert.equal(raws.length,2);
  retry={known:false,latestNonce:1,pendingNonce:1};
  await assert.rejects(resolutionTick(options),/nonce/);assert.equal(raws.length,2);
  retry={known:false,latestNonce:0,pendingNonce:1};
  await assert.rejects(resolutionTick(options),/nonce/);assert.equal(signed,1);
  retry={known:false,latestNonce:0,pendingNonce:0};db.data.delete(db.monitorKey);
  await assert.rejects(resolutionTick(options),/monitoring/);assert.equal(raws.length,2);
  assert.equal((await resolutionTick({...options,enabled:false})).status,'pending');
});
test('unhealthy monitoring, stale review and excessive gas stop worker execution',async()=>{
  const f=pilotFixture(now),s=await f.service.status();s.cases.forEach(c=>c.assertionDeadline=String(now-1));
  const db=storage(f.manifest);db.data.delete(db.monitorKey);
  await assert.rejects(resolutionTick({manifest:f.manifest,owner,service:{status:async()=>s},command:db.command,enabled:true,now:()=>now}),/monitoring/);
  const review=await f.service.prepare({owner,action:'finalize',event:0});validateWorkerReview(review,f.manifest,owner,now);
  assert.throws(()=>validateWorkerReview({...review,expiresAt:now},f.manifest,owner,now),/binding/);
  assert.throws(()=>validateWorkerReview({...review,gasLimit:'1500001'},f.manifest,owner,now),/spending/);
  assert.throws(()=>validateWorkerReview({...review,requested:{...review.requested,event:1}},f.manifest,owner,now),/mismatch/);
});

test('dry run checks monitoring even while waiting, without evidence or signing',async()=>{
  const f=pilotFixture(now),db=storage(f.manifest);
  const forbidden=async()=>{assert.fail('Dry run must not prepare, gather evidence or sign');};
  const options={manifest:f.manifest,owner,service:{status:f.service.status,prepare:forbidden},command:db.command,
    evidence:forbidden,transport:{sign:forbidden,broadcast:forbidden},now:()=>now};
  assert.deepEqual(await resolutionTick(options),{status:'dry-run',plan:{kind:'wait'},pool:f.manifest.pool,monitoring:'healthy'});
  const healthy=JSON.parse(db.data.get(db.monitorKey)!);
  for(const state of [null,{...healthy,checkpoint:{...healthy.checkpoint,checkedAt:now-901}},
    {...healthy,queue:[{status:'pending'}]}, {...healthy,checkpoint:{...healthy.checkpoint,identity:'another-pool'}}]){
    if(state)db.data.set(db.monitorKey,JSON.stringify(state));else db.data.delete(db.monitorKey);
    const result=await resolutionTick(options);
    assert.equal(result.status,'dry-run');assert.equal(result.monitoring,'not-ready');
  }
});

test('worker approves only the exact bond, then asserts; unavailable evidence defers without blocking another event',async()=>{
  const f=pilotFixture(now);f.manifest.publication.draft.closesAt=now-100;
  f.manifest.publication.draft.events.forEach(e=>e.observationEndsAt=now-10);
  const db=storage(f.manifest);let nonce=0;
  const transport={sign:async(review:any)=>account.signTransaction({chainId:10143,type:'legacy',nonce:nonce++,to:review.transaction.to,data:review.transaction.data,value:0n,gas:BigInt(review.gasLimit),gasPrice:BigInt(review.gasPrice)}),broadcast:async()=>{},receipt:async()=>({confirmed:true,success:true})};
  const clear=async()=>({clear:true,positions:[],wrapped:[],blockNumber:'100',checkedClaims:2});
  const options={manifest:f.manifest,owner,service:f.service,command:db.command,transport,proposerHoldings:clear,enabled:true,now:()=>now,evidence:async()=>({outcome:2,hash:'0x'+'ab'.repeat(32),uri:'https://flurbo.singu.online/api/pilot/evidence/fixture'})};
  assert.equal((await resolutionTick(options)).action,'approve');
  assert.equal((await resolutionTick(options)).status,'confirmed');f.options.allowance=1000000n;
  assert.equal((await resolutionTick(options)).action,'assertOutcome');
  assert.equal((await resolutionTick(options)).status,'confirmed');
  const fresh=storage(f.manifest);
  assert.equal((await resolutionTick({...options,command:fresh.command,evidence:async()=>null})).status,'awaiting-evidence');
  assert.equal((await resolutionTick({...options,command:fresh.command,enabled:false})).plan.event,1);
});

test('legacy pool ownership survives a pool switch; any other pending transaction blocks signing',async()=>{
  const f=pilotFixture(now),db=storage(f.manifest),oldPool='0x'+'ab'.repeat(20);
  const old={schema:'flurbo.resolution-worker.v1',pool:oldPool,rulesHash:'old-rules',pending:null,owned:{0:{outcome:2,evidenceHash:'retained'}},deferred:{}};
  db.data.set(journalKey,JSON.stringify(old));
  const state=await f.service.status();state.cases.forEach(c=>c.assertionDeadline=String(now-1));
  const options={manifest:f.manifest,owner,service:{status:async()=>state,prepare:f.service.prepare},command:db.command,enabled:true,now:()=>now,
    transport:{sign:async(review:any)=>account.signTransaction({chainId:10143,type:'legacy',nonce:0,to:review.transaction.to,data:review.transaction.data,value:0n,gas:BigInt(review.gasLimit),gasPrice:BigInt(review.gasPrice)}),broadcast:async()=>{}}};
  assert.equal((await resolutionTick(options)).status,'submitted');
  const saved=JSON.parse(db.data.get(journalKey)!);assert.deepEqual(saved.pools[oldPool],old);assert.ok(saved.pools[f.manifest.pool].pending);
  db.data.set(journalKey,JSON.stringify({...old,pending:{hash:'unreconciled'}}));
  await assert.rejects(resolutionTick(options),/other pool pending/);
});

test('NO assertions are allowed only for canonical activity rules, with calldata matching the evidence',async()=>{
  const f=pilotFixture(now,4);f.options.allowance=1000000n;
  const close=now-3000;f.manifest.publication.mode='ethereum-activity';
  Object.assign(f.manifest.publication.draft,{title:'Showcase v0',clusterId:`showcase-v0-${close}`,closesAt:close,events:ACTIVITY_METRICS.map(m=>activityEvent(m,close+120))});
  const review=await f.service.prepare({owner,action:'assertOutcome',event:0,outcome:1,evidenceHash:'0x'+'ab'.repeat(32),evidenceURI:'https://flurbo.singu.online/api/pilot/evidence/test'});
  validateWorkerReview(review,f.manifest,owner,now);
  assert.throws(()=>validateWorkerReview({...review,requested:{...review.requested,outcome:2}},f.manifest,owner,now),/mismatch/);
  f.manifest.publication.mode='official-releases';assert.throws(()=>validateWorkerReview(review,f.manifest,owner,now),/mismatch/);
});

