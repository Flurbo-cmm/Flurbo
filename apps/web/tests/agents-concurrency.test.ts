import assert from 'node:assert/strict';
import {test} from 'node:test';
import {decodeFunctionData} from 'viem';
import {pilotPoolAbi} from '../shared/pilot.mjs';
import {alice,setup,forecast} from './agent-fixture.ts';
import {owner} from './pilot-fixture.ts';

// Regressions for concurrent writes and durable lifecycle records. Two API instances share one durable
// store, as two hosted servers would. Gates make each interleaving deterministic.
const gate=()=>{let open!:()=>void;const promise=new Promise<void>(r=>{open=r;});return {promise,open};};
const until=async(check:()=>boolean)=>{for(let i=0;i<500&&!check();i++)await new Promise(r=>setTimeout(r,2));assert.ok(check(),'condition not reached');};
const proposalsOf=async(s:ReturnType<typeof setup>,id:string)=>(await s.call(alice,'GET',`/api/agents/${id}`)).body.records.filter((r:any)=>r.kind==='proposal');

async function agentWithDecision(s:ReturnType<typeof setup>,mode='approval'){
  const id=(await s.call(alice,'POST','/api/agents',{name:'Race agent',namespace:'pilot',mode})).body.id;
  const decision=(await s.call(alice,'POST',`/api/agents/${id}/evaluate`,{forecast:forecast(s.f.manifest.pool)})).body;
  assert.equal(decision.decision.outcome,'propose');
  return {id,decision};
}
function slowPrepare(s:ReturnType<typeof setup>){
  const original=s.f.service.prepare,hold=gate();let entered=0;
  s.f.service.prepare=async(input:any)=>{entered++;await hold.promise;return original(input);};
  return {hold,entered:()=>entered,restore:()=>{s.f.service.prepare=original;}};
}

test('two servers proposing the same decision at once create exactly one live proposal',async()=>{
  const s=setup();s.f.options.allowance=10n**12n;
  const {id,decision}=await agentWithDecision(s),other=s.make(),original=s.f.service.prepare,gates:(()=>void)[]=[];
  s.f.service.prepare=async(input:any)=>{await new Promise<void>(r=>gates.push(r));return original(input);};
  const first=s.call(alice,'POST',`/api/agents/${id}/proposal`,{decisionId:decision.id,owner});
  const second=s.call(alice,'POST',`/api/agents/${id}/proposal`,{decisionId:decision.id,owner},other);
  await until(()=>gates.length>=1);await new Promise(r=>setTimeout(r,30));
  // Staggered completion. Without an atomic reservation both requests prepare and both insert (two 200s).
  gates[0]();const r1=await first;gates[1]?.();const r2=await second;
  assert.deepEqual([r1.status,r2.status],[200,409],JSON.stringify([r1.body,r2.body]));
  assert.equal(r2.body.code,'PROPOSAL_EXISTS');
  assert.equal(gates.length,1,'the losing request never reaches transaction preparation');
  const live=(await proposalsOf(s,id)).filter((p:any)=>['preparing','awaiting-approval','submitted','approval-confirmed','confirmed'].includes(p.status));
  assert.equal(live.length,1);
});

test('failed or abandoned preparation releases the decision; a retry never yields a second live proposal',async()=>{
  const s=setup();s.f.options.allowance=10n**12n;
  const {id,decision}=await agentWithDecision(s),original=s.f.service.prepare;
  s.f.service.prepare=async()=>{throw Error('RPC outage');};
  assert.equal((await s.call(alice,'POST',`/api/agents/${id}/proposal`,{decisionId:decision.id,owner})).status,409);
  assert.equal((await proposalsOf(s,id))[0].status,'preparation-failed');
  s.f.service.prepare=original;
  const retry=await s.call(alice,'POST',`/api/agents/${id}/proposal`,{decisionId:decision.id,owner});
  assert.equal(retry.status,200);
  assert.equal((await s.call(alice,'POST',`/api/agents/${id}/proposal`,{decisionId:decision.id,owner})).body.code,'PROPOSAL_EXISTS');
  // A server that crashed mid-preparation leaves a reservation that expires rather than blocking forever.
  const s2=setup();s2.f.options.allowance=10n**12n;
  const second=await agentWithDecision(s2),slow=slowPrepare(s2);
  const crashed=s2.call(alice,'POST',`/api/agents/${second.id}/proposal`,{decisionId:second.decision.id,owner});
  await until(()=>slow.entered()>=1);
  assert.equal((await s2.call(alice,'POST',`/api/agents/${second.id}/proposal`,{decisionId:second.decision.id,owner},s2.make())).body.code,'PROPOSAL_EXISTS');
  s2.advance(61);slow.restore();
  const takeover=await s2.call(alice,'POST',`/api/agents/${second.id}/proposal`,{decisionId:second.decision.id,owner},s2.make());
  assert.equal(takeover.status,200,'an expired reservation no longer blocks the decision');
  slow.hold.open();
  const late=await crashed;
  assert.equal(late.status,409,'a reservation that expired cannot become live afterwards');
  assert.equal((await proposalsOf(s2,second.id)).filter((p:any)=>p.status==='awaiting-approval').length,1);
});

test('a slow refresh cannot overwrite a transaction registered meanwhile; hash registration is idempotent',async()=>{
  const s=setup();
  const {id,decision}=await agentWithDecision(s);
  const proposal=(await s.call(alice,'POST',`/api/agents/${id}/proposal`,{decisionId:decision.id,owner})).body;
  assert.equal(proposal.review.action,'approve');
  const path=`/api/agents/${id}/proposals/${proposal.id}`,slow=slowPrepare(s);s.f.options.allowance=10n**12n;
  const refresh=s.call(alice,'POST',path,{action:'refresh'});
  await until(()=>slow.entered()>=1);
  const hash='0x'+'d1'.repeat(32);
  assert.equal((await s.call(alice,'POST',path,{action:'submitted',hash,transaction:proposal.review.transaction},s.make())).body.status,'submitted');
  slow.hold.open();
  const late=await refresh;
  assert.equal(late.status,409);assert.equal(late.body.code,'PROPOSAL_CHANGED');
  const [saved]=await proposalsOf(s,id);
  assert.equal(saved.status,'submitted');assert.equal(saved.transactions[0].hash,hash);assert.equal(saved.review.action,'approve','the reviewed transaction is the one that was sent');
  // Same proposal and same hash: idempotent. A different hash: explicit conflict.
  assert.equal((await s.call(alice,'POST',path,{action:'submitted',hash,transaction:proposal.review.transaction})).status,200);
  const conflict=await s.call(alice,'POST',path,{action:'submitted',hash:'0x'+'d2'.repeat(32),transaction:proposal.review.transaction});
  assert.equal(conflict.status,409);assert.equal(conflict.body.code,'HASH_CONFLICT');
  // Archiving an agent with a transaction still being tracked keeps the tracking.
  assert.equal((await s.call(alice,'POST',`/api/agents/${id}/delete`,{})).status,200);
  assert.equal((await proposalsOf(s,id))[0].transactions[0].hash,hash);
});

test('more than 100 records never evict unresolved transactions, referenced decisions or accounting',async()=>{
  const s=setup();s.f.options.allowance=10n**12n;
  const {id,decision}=await agentWithDecision(s);
  const paper=await s.call(alice,'POST',`/api/agents/${id}/paper`,{decisionId:decision.id});assert.equal(paper.status,200);
  const proposal=(await s.call(alice,'POST',`/api/agents/${id}/proposal`,{decisionId:decision.id,owner})).body;
  const hash='0x'+'e1'.repeat(32),path=`/api/agents/${id}/proposals/${proposal.id}`;
  await s.call(alice,'POST',path,{action:'submitted',hash,transaction:proposal.review.transaction});
  for(let i=0;i<105;i++){
    if(i%25===24)s.advance(3600); // stay within the hourly evaluation limit
    assert.equal((await s.call(alice,'POST',`/api/agents/${id}/evaluate`,{forecast:forecast(s.f.manifest.pool)})).status,200,`evaluation ${i}`);
  }
  const all=(await s.call(alice,'GET',`/api/agents/${id}`)).body.records;
  assert.ok(all.filter((r:any)=>r.kind==='decision').length<=100,'the activity feed stays bounded');
  const [kept]=await proposalsOf(s,id);
  assert.equal(kept.status,'submitted','the submitted transaction survives the feed limit');
  // Recovery still works: the receipt is verified against the stored review, and the purchase is costed.
  const args=decodeFunctionData({abi:pilotPoolAbi,data:kept.review.transaction.data}).args as any[];
  s.mine(kept.review.transaction,hash,{logs:[]});
  const checked=(await s.call(alice,'POST',path,{action:'check'})).body;
  assert.equal(checked.status,'confirmed');assert.equal(args[2].toString(),decision.decision.proposal.quantityAtoms);
  const perf=(await s.call(alice,'POST',`/api/agents/${id}/performance`,{})).body;
  assert.equal(perf.live.confirmedPurchases,1);
  assert.equal(perf.paper.fills,1,'paper fills are counted after the feed limit');assert.equal(perf.paper.costBasisAtoms,'250000');
  // The paper budget still includes the old fill: 50 AUSD budget minus 0.25 already spent.
  assert.equal((await s.call(alice,'POST',`/api/agents/${id}/update`,{config:{...(await s.call(alice,'GET',`/api/agents/${id}`)).body.profile.config,paperBudgetAtoms:'400000'}})).status,200);
  s.advance(-4*3600); // back to the fixed chain time, so the new quote is fresh
  const fresh=(await s.call(alice,'POST',`/api/agents/${id}/evaluate`,{forecast:forecast(s.f.manifest.pool)})).body;
  const overBudget=await s.call(alice,'POST',`/api/agents/${id}/paper`,{decisionId:fresh.id});
  assert.equal(overBudget.status,409);assert.match(overBudget.body.error,/paper budget/,'cumulative paper cost still counts the fill made before trimming');
});

test('a hash is bound to the exact reviewed transaction it came from, including a review replaced meanwhile',async()=>{
  const s=setup();
  const {id,decision}=await agentWithDecision(s);
  const proposal=(await s.call(alice,'POST',`/api/agents/${id}/proposal`,{decisionId:decision.id,owner})).body;
  const path=`/api/agents/${id}/proposals/${proposal.id}`,opened=proposal.review.transaction;
  // Another tab refreshes while the approval is open in MetaMask; the user then confirms the older review.
  s.f.options.allowance=10n**12n;
  assert.equal((await s.call(alice,'POST',path,{action:'refresh'})).body.review.action,'buy');
  const stranger={...opened,data:opened.data.slice(0,-2)+'ff'};
  const refused=await s.call(alice,'POST',path,{action:'submitted',hash:'0x'+'f0'.repeat(32),transaction:stranger});
  assert.equal(refused.status,409);assert.equal(refused.body.code,'REVIEW_MISMATCH');
  const hash='0x'+'f1'.repeat(32),bound=(await s.call(alice,'POST',path,{action:'submitted',hash,transaction:opened})).body;
  assert.equal(bound.status,'submitted');assert.equal(bound.transactions[0].review.action,'approve');assert.equal(bound.transactions[0].review.transaction.data,opened.data);
  s.mine(opened,hash);
  assert.equal((await s.call(alice,'POST',path,{action:'check'})).body.status,'approval-confirmed','verified against the review that was actually sent');
  // The same hash on another proposal of this agent is a conflict, not a second purchase record.
  const next=(await s.call(alice,'POST',`/api/agents/${id}/evaluate`,{forecast:forecast(s.f.manifest.pool)})).body;
  const second=(await s.call(alice,'POST',`/api/agents/${id}/proposal`,{decisionId:next.id,owner})).body;
  const reused=await s.call(alice,'POST',`/api/agents/${id}/proposals/${second.id}`,{action:'submitted',hash,transaction:second.review.transaction});
  assert.equal(reused.status,409);assert.equal(reused.body.code,'HASH_CONFLICT');
});

test('records stored under the previous schema are read, counted once and converted on the next change',async()=>{
  const s=setup();s.f.options.allowance=10n**12n;
  const {id,decision}=await agentWithDecision(s);
  assert.equal((await s.call(alice,'POST',`/api/agents/${id}/paper`,{decisionId:decision.id})).status,200);
  const proposal=(await s.call(alice,'POST',`/api/agents/${id}/proposal`,{decisionId:decision.id,owner})).body;
  const path=`/api/agents/${id}/proposals/${proposal.id}`,hash='0x'+'ab'.repeat(32);
  await s.call(alice,'POST',path,{action:'submitted',hash,transaction:proposal.review.transaction});
  s.mine(proposal.review.transaction,hash);
  assert.equal((await s.call(alice,'POST',path,{action:'check'})).body.status,'confirmed');
  const before=(await s.call(alice,'POST',`/api/agents/${id}/performance`,{})).body;
  // Rewrite the stored state as the v1 single capped list, as deployed before this change.
  const stateKey=(await s.redis.keys()).find(k=>k.endsWith(':state:'+id))!,base=stateKey.slice(0,-(':state:'+id).length);
  const state=JSON.parse((await s.redis.get(stateKey))!);
  const legacy=[...state.proposals.map(({version,decision,superseded,...p}:any)=>({...p,transactions:p.transactions.map(({accounted,submittedAt,...t}:any)=>t)})),
    ...state.paper.recent,...state.decisions.map(({paperFillId,...d}:any)=>d)];
  await s.redis.del(stateKey);await s.redis.del(base+':rev:'+id);await s.redis.set(base+':records:'+id,JSON.stringify(legacy));
  for(const k of await s.redis.keys())if(k.includes(':owner:'))await s.redis.del(k); // v1 had no ownership records
  const read=(await s.call(alice,'GET',`/api/agents/${id}`)).body.records;
  assert.equal(read.filter((r:any)=>r.kind==='proposal')[0].status,'confirmed');
  const after=(await s.call(alice,'POST',`/api/agents/${id}/performance`,{})).body;
  assert.deepEqual([after.paper.fills,after.paper.costBasisAtoms,after.live.confirmedPurchases,after.live.costBasisAtoms],
    [before.paper.fills,before.paper.costBasisAtoms,before.live.confirmedPurchases,before.live.costBasisAtoms]);
  assert.match((await s.call(alice,'POST',`/api/agents/${id}/paper`,{decisionId:decision.id})).body.error,/already paper traded/,'a migrated decision keeps its fill');
  assert.equal((await s.call(alice,'POST',`/api/agents/${id}/proposal`,{decisionId:decision.id,owner})).body.code,'PROPOSAL_EXISTS','a migrated confirmed proposal still blocks');
  await s.call(alice,'POST',`/api/agents/${id}/evaluate`,{forecast:forecast(s.f.manifest.pool)});
  assert.ok(await s.redis.get(stateKey)&&!await s.redis.get(base+':records:'+id),'converted on read');
  const converted=(await s.call(alice,'POST',`/api/agents/${id}/performance`,{})).body;
  assert.equal(converted.live.confirmedPurchases,1,'the confirmed purchase is not counted twice');assert.equal(converted.paper.fills,1);
});

test('a writer whose lock lapsed while another server took over cannot overwrite the newer state',async()=>{
  const {agentStore,redisBackend}=await import('../server/agents/agent-store.mjs');
  const s=setup(),{id}=await agentWithDecision(s),store=agentStore(redisBackend(s.redis.command)),hold=gate();
  const slow=store.mutate(alice,id,async(state:any)=>{await hold.promise;state.decisions=[];return 'stale';});
  await new Promise(r=>setTimeout(r,20));
  // Simulate the lock expiring, then a second server committing a change.
  for(const k of await s.redis.keys())if(k.endsWith(':lock'))await s.redis.del(k);
  assert.equal(await store.mutate(alice,id,async(state:any)=>{state.decisions[0].note='newer';return 'newer';}),'newer');
  hold.open();
  await assert.rejects(slow,/in progress/);
  const decisions=(await s.call(alice,'GET',`/api/agents/${id}`)).body.records.filter((r:any)=>r.kind==='decision');
  assert.equal(decisions.length,1);assert.equal(decisions[0].note,'newer');
});
