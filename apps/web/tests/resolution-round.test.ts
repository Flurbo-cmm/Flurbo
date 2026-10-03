import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {privateKeyToAccount} from 'viem/accounts';
import {pilotFixture} from './pilot-fixture.ts';
import {nextResolutionAction,resolutionRound} from '../server/resolution-worker.mjs';
import {monitorIdentity} from '../server/settlement-monitor.mjs';
import {settlementCalendar,dueEntries,nextWake} from '../shared/settlement-calendar.mjs';
import {finishingManifests} from '../scripts/run-resolution.mjs';

const account=privateKeyToAccount(('0x'+'12'.repeat(32)) as `0x${string}`),owner=account.address.toLowerCase(),now=1800000000;
const journalKey='flurbo:monitor:v1:'+createHash('sha256').update('resolution-worker-v1:'+owner).digest('hex')+':state';
const monitorKey=(m:any)=>'flurbo:monitor:v1:'+createHash('sha256').update(monitorIdentity(m)).digest('hex')+':state';
function store(healthy:any[]){
  const data=new Map<string,string>();
  const command=async(op:string,...a:any[])=>{
    if(op==='GET')return data.get(a[0])??null;
    if(op==='SET'){if(a.includes('NX')&&data.has(a[0]))return null;data.set(a[0],a[1]);return 'OK';}
    if(op==='EVAL'){const [,,lock,key,token,mode,body]=a;if(data.get(lock)!==token)return 0;if(mode==='release')data.delete(lock);if(mode==='save')data.set(key,body);return 1;}
    throw Error('Unexpected store call');
  };
  for(const m of healthy)data.set(monitorKey(m),JSON.stringify({checkpoint:{identity:monitorIdentity(m),checkedAt:now},report:{status:'observed'},queue:[]}));
  return {data,command};
}
const signer={sign:async(review:any)=>account.signTransaction({chainId:10143,type:'legacy',nonce:0,to:review.transaction.to,data:review.transaction.data,value:0n,gas:BigInt(review.gasLimit),gasPrice:BigInt(review.gasPrice)}),
  broadcast:async()=>{},receipt:async()=>({confirmed:true,success:true})};
const forbidden=async()=>{assert.fail('This pool must not prepare, gather evidence or sign');};
const clear=async()=>({clear:true,positions:[],wrapped:[],blockNumber:'100',checkedClaims:2});

// Finish-only pool: the real fixture, with its assertion deadline passed so a timeout finalize is due.
async function finishPool(){
  const f=pilotFixture(now,4),s=await f.service.status();s.cases.forEach((c:any)=>c.assertionDeadline=String(now-1));
  return {manifest:f.manifest,service:{status:async()=>structuredClone(s),prepare:f.service.prepare},evidence:null};
}
// Proposing pool: a relabelled copy inside its evidence window. It never reaches prepare in these tests.
async function evidencePool(evidence:any=async()=>null){
  const f=pilotFixture(now,4),s=await f.service.status();
  const manifest={...structuredClone(f.manifest),pool:'0x'+'aa'.repeat(20),resolver:'0x'+'ab'.repeat(20)};
  manifest.publication.draft.events.forEach((e:any)=>e.observationEndsAt=now-10);
  s.manifest=manifest;s.cases.forEach((c:any)=>c.assertionDeadline=String(now+3600));
  return {manifest,service:{status:async()=>structuredClone(s),prepare:forbidden},evidence,proposerHoldings:clear};
}

test('calendar lists exactly the actions the planner can take, at every phase and time',async()=>{
  const f=pilotFixture(now,4),base=await f.service.status();
  const ends=base.manifest.publication.draft.events.map((e:any)=>e.observationEndsAt);
  const cases=[
    {phase:0},{phase:1,proposal:2,asserter:owner,evidenceHash:'0x'+'ab'.repeat(32),challengeUntil:String(ends[1]+7200)},
    {phase:1,proposal:2,asserter:'0x'+'77'.repeat(20),evidenceHash:'0x'+'cd'.repeat(32),challengeUntil:String(ends[2]+7200)},
    {phase:2,proposal:2,counter:1,voteUntil:String(ends[3]+9000)}];
  const owned={1:{outcome:2,evidenceHash:'0x'+'ab'.repeat(32)}};
  for(const evidence of [true,false])for(const mode of ['release','rehearsal','ethereum-activity']){
    const s=structuredClone(base);s.manifest.publication.mode=mode;
    s.cases=s.cases.map((c:any,i:number)=>({...c,...cases[i]}));
    const calendar=settlementCalendar(s,{owner,owned,evidence});
    const times=[...new Set([...calendar.entries.flatMap((e:any)=>[e.readyAt-1,e.readyAt,e.deadline??e.readyAt+1]),ends[0]-5,ends[0]+100000])];
    for(const t of times){
      s.snapshot.timestamp=t;
      const plan=nextResolutionAction(s,owner,owned,{},{evidence}),due=dueEntries(calendar,t);
      assert.equal(['transaction','evidence'].includes(plan.kind),due.length>0,`mode ${mode} evidence ${evidence} t ${t}`);
      if(due.length)assert.ok(due.some((e:any)=>e.event===(plan.event??null)&&e.action===(plan.kind==='evidence'?'evidence':plan.action)));
    }
    // The foreign assertion on event 2 is never scheduled for automatic finalization.
    assert.ok(!calendar.entries.some((e:any)=>e.event===2&&e.action==='finalize'&&e.readyAt===Number(cases[2].challengeUntil)));
  }
  const done=structuredClone(base);done.cases.forEach((c:any)=>c.phase=3);
  assert.deepEqual(settlementCalendar(done,{owner}).entries.map((e:any)=>e.action),['deliver']);
  done.delivered=true;assert.equal(settlementCalendar(done,{owner}).complete,true);
  assert.equal(nextWake([settlementCalendar(base,{owner,evidence:true})],now),Math.min(...ends));
});

test('round works through every pool: blocked evidence defers, a finish-only pool still settles',async()=>{
  const a=await evidencePool(),b=await finishPool(),db=store([a.manifest,b.manifest]);
  const result=await resolutionRound({pools:[b,a],owner,command:db.command,transport:signer,enabled:true,now:()=>now});
  assert.equal(result.status,'submitted');assert.equal(result.pool,b.manifest.pool);assert.equal(result.action,'finalize');
  assert.deepEqual(result.skipped,[]);
  const journal=JSON.parse(db.data.get(journalKey)!);
  assert.ok(journal.pools[a.manifest.pool].deferred[0]>now,'evidence retry deferred on the proposing pool');
  assert.ok(journal.pools[b.manifest.pool].pending,'finish-only pool journaled before broadcast');
});

test('stale monitoring or an unreadable pool is skipped and reported without blocking other pools',async()=>{
  const a=await evidencePool(forbidden),b=await finishPool();
  const stale=store([b.manifest]);
  const first=await resolutionRound({pools:[a,b],owner,command:stale.command,transport:signer,enabled:true,now:()=>now});
  assert.equal(first.status,'submitted');assert.equal(first.pool,b.manifest.pool);
  assert.deepEqual(first.skipped,[{pool:a.manifest.pool,reason:'monitoring-stale'}]);
  const broken={...a,service:{status:async()=>{throw Error('RPC outage');},prepare:forbidden}};
  const second=await resolutionRound({pools:[broken,await finishPool()],owner,command:store([a.manifest,b.manifest]).command,transport:signer,enabled:true,now:()=>now});
  assert.equal(second.status,'submitted');assert.deepEqual(second.skipped,[{pool:a.manifest.pool,reason:'read-or-plan-failed'}]);
  const none=await resolutionRound({pools:[await finishPool()],owner,command:store([]).command,transport:signer,enabled:true,now:()=>now});
  assert.equal(none.status,'monitoring-stale');
});

test('a pending transaction is reconciled first; one on an unregistered pool stops the round',async()=>{
  const a=await evidencePool(),b=await finishPool(),db=store([a.manifest,b.manifest]);
  const first=await resolutionRound({pools:[a,b],owner,command:db.command,transport:signer,enabled:true,now:()=>now});
  assert.equal(first.status,'submitted');
  const second=await resolutionRound({pools:[a,b],owner,command:db.command,transport:signer,enabled:true,now:()=>now});
  assert.equal(second.status,'confirmed');assert.equal(second.pool,b.manifest.pool);
  const journal=JSON.parse(db.data.get(journalKey)!);
  journal.pools['0x'+'ee'.repeat(20)]={schema:'flurbo.resolution-worker.v1',pool:'0x'+'ee'.repeat(20),rulesHash:'x',pending:{hash:'0x00'},owned:{},deferred:{}};
  db.data.set(journalKey,JSON.stringify(journal));
  await assert.rejects(resolutionRound({pools:[a,b],owner,command:db.command,transport:signer,enabled:true,now:()=>now}),/unregistered pool/);
});

test('finish-only pools never propose; release pools never propose NO; signer conflicts are skipped',async()=>{
  const b=await finishPool(),window=await b.service.status();
  window.cases.forEach((c:any)=>c.assertionDeadline=String(now+3600));window.manifest.publication.draft.events.forEach((e:any)=>e.observationEndsAt=now-10);
  const quiet={...b,service:{status:async()=>structuredClone(window),prepare:forbidden}};
  const idle=await resolutionRound({pools:[quiet],owner,command:store([b.manifest]).command,transport:{sign:forbidden,broadcast:forbidden},enabled:true,now:()=>now});
  assert.equal(idle.status,'wait');
  const no=await evidencePool(async()=>({outcome:1,hash:'0x'+'ab'.repeat(32),uri:'https://flurbo.singu.online/api/pilot/evidence/x'}));
  await assert.rejects(resolutionRound({pools:[no],owner,command:store([no.manifest]).command,transport:signer,enabled:true,now:()=>now}),/Unsupported source-checked outcome/);
  const conflict=await finishPool();conflict.manifest.publication.creator=owner;
  const skipped=await resolutionRound({pools:[conflict],owner,command:store([conflict.manifest]).command,transport:signer,enabled:true,now:()=>now});
  assert.deepEqual(skipped.skipped,[{pool:conflict.manifest.pool,reason:'signer-role-conflict'}]);
});

test('dry run reports every pool with its monitoring state and never signs',async()=>{
  const a=await evidencePool(forbidden),b=await finishPool();
  const result=await resolutionRound({pools:[a,b],owner,command:store([b.manifest]).command,transport:{sign:forbidden,broadcast:forbidden},now:()=>now});
  assert.equal(result.status,'dry-run');
  assert.deepEqual(result.pools.map((p:any)=>[p.pool,p.plan.kind,p.monitoring]),[[a.manifest.pool,'evidence','not-ready'],[b.manifest.pool,'transaction','healthy']]);
  await assert.rejects(resolutionRound({pools:[b,b],owner,command:store([]).command,transport:signer,now:()=>now}),/Duplicate/);
});

test('several proposing pools are each asked for evidence in one round, and idle pools are not read',async()=>{
  const asked:string[]=[];
  const a=await evidencePool(async()=>{asked.push('a');return null;}),second=await evidencePool(async()=>{asked.push('c');return null;});
  const c={...second,manifest:{...second.manifest,pool:'0x'+'cc'.repeat(20),resolver:'0x'+'cd'.repeat(20)}};
  const db=store([a.manifest,c.manifest]);
  const result=await resolutionRound({pools:[a,c],owner,command:db.command,transport:signer,enabled:true,now:()=>now});
  assert.equal(result.status,'wait');assert.deepEqual(asked.sort(),['a','c']);
  const journal=JSON.parse(db.data.get(journalKey)!);
  assert.ok(journal.pools[a.manifest.pool].deferred[0]>now&&journal.pools[c.manifest.pool].deferred[0]>now,'each pool defers its own retry');
  const unread={...(await finishPool()),service:{status:async()=>assert.fail('an idle pool must not be read'),prepare:forbidden}};
  const quiet=await resolutionRound({pools:[unread],owner,command:store([unread.manifest]).command,transport:signer,enabled:true,now:()=>now,idle:new Set([unread.manifest.pool])});
  assert.equal(quiet.status,'wait');assert.equal(quiet.idle,1);
});

test('finishing pools need a bundle and an exact allowlist; unset keeps single-pool mode',async()=>{
  const f=pilotFixture(now,4),primary={...structuredClone(f.manifest),pool:'0x'+'aa'.repeat(20)},m=f.manifest,key=(m.pool+':'+m.rulesHash).toLowerCase();
  assert.equal(finishingManifests({},primary),null);
  assert.equal(finishingManifests({FLURBO_RESOLUTION_COLLECTIONS_JSON:'',FLURBO_RESOLUTION_FINISH_ALLOWLIST:''},primary),null);
  assert.throws(()=>finishingManifests({FLURBO_RESOLUTION_COLLECTIONS_JSON:JSON.stringify([m])},primary),/both/);
  assert.equal(finishingManifests({FLURBO_RESOLUTION_COLLECTIONS_JSON:JSON.stringify([{manifest:m},{manifest:primary}]),FLURBO_RESOLUTION_FINISH_ALLOWLIST:key}, primary).length,1);
  const other={...structuredClone(m),pool:'0x'+'bb'.repeat(20)};
  assert.throws(()=>finishingManifests({FLURBO_RESOLUTION_COLLECTIONS_JSON:JSON.stringify([m,other]),FLURBO_RESOLUTION_FINISH_ALLOWLIST:key},primary),/exactly/);
  assert.throws(()=>finishingManifests({FLURBO_RESOLUTION_COLLECTIONS_JSON:JSON.stringify([m]),FLURBO_RESOLUTION_FINISH_ALLOWLIST:key+','+key},primary),/allowlist/);
  assert.throws(()=>finishingManifests({FLURBO_RESOLUTION_COLLECTIONS_JSON:JSON.stringify([{...m,rulesHash:'0x'+'00'.repeat(32)}]),FLURBO_RESOLUTION_FINISH_ALLOWLIST:key},primary),/exactly/);
});

test('regression: an unreadable pool never removes healthy pools from the plan or the next wake time',async()=>{
  const a=await evidencePool(forbidden),b=await finishPool();
  const broken={...a,service:{status:async()=>{throw Error('RPC outage');},prepare:forbidden}};
  const later=await b.service.status();later.cases.forEach((c:any)=>c.assertionDeadline=String(now+7200));
  const healthy={...b,service:{status:async()=>structuredClone(later),prepare:forbidden}};
  const result=await resolutionRound({pools:[broken,healthy],owner,command:store([b.manifest]).command,transport:{sign:forbidden,broadcast:forbidden},now:()=>now});
  assert.deepEqual(result.skipped,[{pool:a.manifest.pool,reason:'read-or-plan-failed'}]);
  assert.deepEqual(result.pools.map((p:any)=>p.pool),[b.manifest.pool]);
  assert.equal(result.nextWake,now+7200,'the healthy pool still reports when it next needs the worker');
});
