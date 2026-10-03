import assert from 'node:assert/strict';
import {test} from 'node:test';
import {decodeFunctionData,encodeFunctionData,encodeAbiParameters,encodeEventTopics} from 'viem';
import {pilotPoolAbi} from '../shared/pilot.mjs';
import {alice,bob,setup,forecast} from './agent-fixture.ts';
import {owner} from './pilot-fixture.ts';

// A sent transaction must stay recoverable whatever happens to its review, proposal or agent. Recording a
// hash is provisional; ownership of an on-chain transaction goes to the one proposal whose reviewed
// transaction the receipt check proves it is, once, across agents, server instances and accounts. The
// server never sends anything: recovery records a hash and verifies its receipt.
type Setup=ReturnType<typeof setup>;
const proposalsOf=async(s:Setup,id:string,login=alice)=>(await s.call(login,'GET',`/api/agents/${id}`)).body.records.filter((r:any)=>r.kind==='proposal');
async function agent(s:Setup,login=alice,name='Recovery agent'){
  const id=(await s.call(login,'POST','/api/agents',{name,namespace:'pilot',mode:'approval'})).body.id;
  const decision=(await s.call(login,'POST',`/api/agents/${id}/evaluate`,{forecast:forecast(s.f.manifest.pool)})).body;
  assert.equal(decision.decision.outcome,'propose');
  return {id,decision};
}
const propose=async(s:Setup,id:string,decisionId:string,login=alice)=>{const r=await s.call(login,'POST',`/api/agents/${id}/proposal`,{decisionId,owner});assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
const register=(s:Setup,id:string,proposal:any,hash:string,transaction:any,login=alice,which=s.api)=>s.call(login,'POST',`/api/agents/${id}/proposals/${proposal.id}`,{action:'submitted',hash,transaction},which);
const check=(s:Setup,id:string,proposal:any,login=alice,which=s.api)=>s.call(login,'POST',`/api/agents/${id}/proposals/${proposal.id}`,{action:'check'},which);
const live=async(s:Setup,id:string,login=alice,which=s.api)=>(await s.call(login,'POST',`/api/agents/${id}/performance`,{},which)).body.live;
const stateKeyOf=async(s:Setup,id:string)=>(await s.redis.keys()).find(k=>k.endsWith(':state:'+id))!;
const stored=async(s:Setup,id:string)=>JSON.parse((await s.redis.get(await stateKeyOf(s,id)))!);
const ownerOf=async(s:Setup,hash:string)=>{const k=(await s.redis.keys()).find(k=>k.endsWith(':owner:10143:'+hash));return k?JSON.parse((await s.redis.get(k))!):null;};
// The receipt shows the pool's Traded event, so the purchase has a known cost.
const tradedLogs=(s:Setup,tx:any)=>{const a=decodeFunctionData({abi:pilotPoolAbi,data:tx.data}).args as any[];
  return [{address:s.f.manifest.pool,topics:encodeEventTopics({abi:pilotPoolAbi,eventName:'Traded',args:{trader:owner,scope:a[0],mask:a[1]}}),
    data:encodeAbiParameters([{type:'bool'},{type:'uint128'},{type:'uint128'}],[true,a[2],250_000n])}];};
// Each prepared purchase gets a slightly lower limit, so every review is a distinct transaction.
function distinctReviews(s:Setup){
  const original=s.f.service.prepare;let lower=0n;
  s.f.service.prepare=async(input:any)=>{const review=await original(input),a=decodeFunctionData({abi:pilotPoolAbi,data:review.transaction.data}).args as any[];
    const limit=a[3]-lower++;
    return {...review,amountAtoms:limit.toString(),transaction:{...review.transaction,data:encodeFunctionData({abi:pilotPoolAbi,functionName:'buy',args:[a[0],a[1],a[2],limit,a[4]]})}};};
}
// Hold the atomic saves that write ownership until `count` of them are waiting, so only the atomic save
// can decide between them.
function holdOwnershipSaves(s:Setup,count:number){
  const command=s.redis.command,waiting:(()=>void)[]=[];let held=0;
  s.redis.command=async(op:string,...args:any[])=>{
    if(op==='EVAL'&&String(args[0]).includes('ARGV[3]')&&args.slice(2,2+Number(args[1])).some((k:any)=>String(k).includes(':owner:'))&&held<count){
      held++;await new Promise<void>(r=>{waiting.push(r);if(waiting.length===count)waiting.forEach(f=>f());});
    }
    return command(op,...args);
  };
  return {held:()=>held,restore:()=>{s.redis.command=command;}};
}

test('a transaction sent before archive, after review expiry and after trimming is still recorded and counted once',async()=>{
  const s=setup();s.f.options.allowance=10n**12n;
  const {id,decision}=await agent(s);
  const target=await propose(s,id,decision.id),sent=target.review.transaction,hash='0x'+'a7'.repeat(32);
  assert.equal(target.review.action,'buy');
  // MetaMask sent it, but the hash never reached the server.
  s.mine(sent,hash,{logs:tradedLogs(s,sent)});
  // Many later proposals are prepared and dismissed, so the target falls outside the full-record window.
  const next=(await s.call(alice,'POST',`/api/agents/${id}/evaluate`,{forecast:forecast(s.f.manifest.pool)})).body;
  for(let i=0;i<55;i++){const p=await propose(s,id,next.id);assert.equal((await s.call(alice,'POST',`/api/agents/${id}/proposals/${p.id}`,{action:'rejected'})).status,200);}
  // Past the review's expiry and the one-day recovery window, then the agent is deleted (archived).
  s.advance(2*86_400);
  assert.equal((await s.call(alice,'POST',`/api/agents/${id}/delete`,{})).status,200);
  const compacted=(await stored(s,id)).proposals.find((p:any)=>p.id===target.id);
  assert.ok(compacted&&!compacted.decision&&compacted.reviews.length===1,'compacted, but the review needed for recovery is kept');
  const recorded=await register(s,id,target,hash,sent);
  assert.equal(recorded.status,200,JSON.stringify(recorded.body));assert.equal(recorded.body.status,'submitted');
  assert.equal((await register(s,id,target,hash,sent)).status,200,'recording again is a no-op');
  assert.equal((await check(s,id,target)).body.status,'confirmed');
  assert.equal((await ownerOf(s,hash)).proposalId,target.id);
  assert.deepEqual([(await live(s,id)).confirmedPurchases,(await live(s,id)).costBasisAtoms],[1,'250000']);
  assert.equal((await check(s,id,target)).body.status,'confirmed');
  assert.equal((await live(s,id)).confirmedPurchases,1,'checking again never counts twice');
  assert.equal((await s.call(alice,'POST',`/api/agents/${id}/evaluate`,{forecast:forecast(s.f.manifest.pool)})).body.code,'ARCHIVED');
});

test('every review a proposal issued stays recoverable after many refreshes',async()=>{
  const s=setup();s.f.options.allowance=10n**12n;distinctReviews(s);
  const {id,decision}=await agent(s);
  const proposal=await propose(s,id,decision.id),opened=proposal.review.transaction,path=`/api/agents/${id}/proposals/${proposal.id}`;
  for(let i=0;i<6;i++)assert.equal((await s.call(alice,'POST',path,{action:'refresh'})).status,200);
  const view=(await proposalsOf(s,id))[0];
  assert.equal(view.reviewedTransactions.length,7);assert.notEqual(view.review.transaction.data,opened.data);
  // The first review, still open in MetaMask, was the one sent.
  const hash='0x'+'b7'.repeat(32);s.mine(opened,hash,{logs:[]});
  const recorded=await register(s,id,proposal,hash,opened);
  assert.equal(recorded.status,200,JSON.stringify(recorded.body));assert.equal(recorded.body.transactions[0].review.transaction.data,opened.data);
  assert.equal((await check(s,id,proposal)).body.status,'confirmed');
  assert.equal((await live(s,id)).confirmedPurchases,1);
});

test('a wrong claim to a real hash never blocks the proposal whose reviewed transaction it is',async()=>{
  const s=setup();s.f.options.allowance=10n**12n;distinctReviews(s);
  const a=await agent(s,alice,'Agent one'),b=await agent(s,alice,'Agent two'),c=await agent(s,alice,'Agent three');
  const pa=await propose(s,a.id,a.decision.id),pb=await propose(s,b.id,b.decision.id),pc=await propose(s,c.id,c.decision.id);
  assert.notEqual(pa.review.transaction.data,pb.review.transaction.data);
  const hash='0x'+'c7'.repeat(32);
  // Before the transaction is visible on-chain, several proposals may record the hash provisionally.
  assert.equal((await register(s,b.id,pb,hash,pb.review.transaction)).status,200,'the wrong claimant records it first');
  assert.equal((await register(s,a.id,pa,hash,pa.review.transaction)).status,200,'the rightful proposal is not blocked');
  assert.equal((await check(s,a.id,pa)).body.check,'unknown','an unknown hash stays tracked, and owned by nobody');
  assert.equal(await ownerOf(s,hash),null);
  // It lands as A's reviewed transaction. Both check at once through separate server instances.
  s.mine(pa.review.transaction,hash,{logs:tradedLogs(s,pa.review.transaction)});
  const [ra,rb]=await Promise.all([check(s,a.id,pa,alice,s.make()),check(s,b.id,pb,alice,s.make())]);
  assert.equal(ra.body.status,'confirmed');assert.equal(rb.body.status,'failed');assert.match(rb.body.failure,/does not match/);
  assert.equal((await ownerOf(s,hash)).proposalId,pa.id);
  assert.deepEqual([(await live(s,a.id)).confirmedPurchases,(await live(s,b.id)).confirmedPurchases],[1,0]);
  // Verified ownership is final: nobody else can record it now.
  assert.equal((await register(s,c.id,pc,hash,pc.review.transaction)).body.code,'HASH_CONFLICT');
  assert.equal((await register(s,a.id,pa,hash,pa.review.transaction)).status,200,'still idempotent for its owner');
});

test('the rightful proposal verifies even when the wrong claimant never checks',async()=>{
  const s=setup();s.f.options.allowance=10n**12n;distinctReviews(s);
  const a=await agent(s,alice,'Agent one'),b=await agent(s,bob,'Agent of another account');
  const pa=await propose(s,a.id,a.decision.id),pb=await propose(s,b.id,b.decision.id,bob);
  const hash='0x'+'c8'.repeat(32);s.mine(pa.review.transaction,hash,{logs:tradedLogs(s,pa.review.transaction)});
  assert.equal((await register(s,b.id,pb,hash,pb.review.transaction,bob)).status,200);
  assert.equal((await register(s,a.id,pa,hash,pa.review.transaction)).status,200);
  assert.equal((await check(s,a.id,pa)).body.status,'confirmed');
  assert.equal((await live(s,a.id)).confirmedPurchases,1);
  assert.equal((await check(s,b.id,pb,bob)).body.status,'failed','checked later, the wrong claim is refused');
  assert.equal((await live(s,b.id,bob)).confirmedPurchases,0);
});

test('identical reviewed transactions in two agents: concurrent checks count the purchase once, and it survives trimming and archive',async()=>{
  const s=setup();s.f.options.allowance=10n**12n;
  const a=await agent(s,alice,'Agent one'),b=await agent(s,alice,'Agent two');
  const pa=await propose(s,a.id,a.decision.id),pb=await propose(s,b.id,b.decision.id);
  assert.equal(pa.review.transaction.data,pb.review.transaction.data,'the two agents prepared identical transactions');
  const hash='0x'+'d7'.repeat(32);s.mine(pa.review.transaction,hash,{logs:tradedLogs(s,pa.review.transaction)});
  const recorded=await Promise.all([register(s,a.id,pa,hash,pa.review.transaction,alice,s.make()),register(s,b.id,pb,hash,pb.review.transaction,alice,s.make())]);
  assert.deepEqual(recorded.map(r=>r.status),[200,200],'recording is provisional');
  const checked=await Promise.all([check(s,a.id,pa,alice,s.make()),check(s,b.id,pb,alice,s.make())]);
  const statuses=checked.map(r=>r.body.status).sort();
  assert.deepEqual(statuses,['awaiting-approval','confirmed'],'the second is returned to its earlier state');
  const [winner,loser]=checked[0].body.status==='confirmed'?[{...a,p:pa},{...b,p:pb}]:[{...b,p:pb},{...a,p:pa}];
  assert.match(checked.find(r=>r.body.status!=='confirmed')!.body.failure,/verified for another proposal/);
  assert.deepEqual([(await live(s,winner.id)).confirmedPurchases,(await live(s,loser.id)).confirmedPurchases],[1,0]);
  // Winner archived and its proposals trimmed or compacted: the ownership record still protects it.
  const later=(await s.call(alice,'POST',`/api/agents/${winner.id}/evaluate`,{forecast:forecast(s.f.manifest.pool)})).body;
  for(let i=0;i<55;i++){const p=await propose(s,winner.id,later.id);await s.call(alice,'POST',`/api/agents/${winner.id}/proposals/${p.id}`,{action:'rejected'});}
  assert.equal((await s.call(alice,'POST',`/api/agents/${winner.id}/delete`,{})).status,200);
  assert.equal((await register(s,loser.id,loser.p,hash,loser.p.review.transaction)).body.code,'HASH_CONFLICT');
  assert.equal((await live(s,loser.id)).confirmedPurchases,0);
  assert.equal((await live(s,winner.id)).confirmedPurchases,1);
});

test('two accounts verifying the same transaction at the same moment: the atomic save admits exactly one owner',async()=>{
  const s=setup();s.f.options.allowance=10n**12n;
  const a=await agent(s,alice),b=await agent(s,bob);
  const pa=await propose(s,a.id,a.decision.id,alice),pb=await propose(s,b.id,b.decision.id,bob);
  const hash='0x'+'e7'.repeat(32);s.mine(pa.review.transaction,hash,{logs:tradedLogs(s,pa.review.transaction)});
  await register(s,a.id,pa,hash,pa.review.transaction,alice);await register(s,b.id,pb,hash,pb.review.transaction,bob);
  const hold=holdOwnershipSaves(s,2);
  const checked=await Promise.all([check(s,a.id,pa,alice,s.make()),check(s,b.id,pb,bob,s.make())]);
  hold.restore();
  assert.equal(hold.held(),2,'both reached the atomic save before either wrote');
  assert.deepEqual(checked.map(r=>r.status),[200,200],'the loser re-reads and records the outcome');
  assert.deepEqual(checked.map(r=>r.body.status).sort(),['awaiting-approval','confirmed']);
  assert.equal((await live(s,a.id,alice)).confirmedPurchases+(await live(s,b.id,bob)).confirmedPurchases,1);
});

// Older states: build one confirmed purchase through the API, then store it as v1 records (one capped
// list, no ownership) under several agents, as if both had confirmed the same transaction.
async function legacyDuplicate(s:Setup,logins:string[]){
  s.f.options.allowance=10n**12n;
  const agents=[];for(const login of logins)agents.push({login,...await agent(s,login,'Legacy '+agents.length)});
  const first=agents[0],p=await propose(s,first.id,first.decision.id,first.login),hash='0x'+'f7'.repeat(32);
  await register(s,first.id,p,hash,p.review.transaction,first.login);
  s.mine(p.review.transaction,hash,{logs:tradedLogs(s,p.review.transaction)});
  assert.equal((await check(s,first.id,p,first.login)).body.status,'confirmed');
  const state=await stored(s,first.id);
  const legacy=[...state.proposals.map(({version,decision,reviews,...r}:any)=>({...r,transactions:r.transactions.map(({accounted,submittedAt,statusBefore,...t}:any)=>t)})),
    ...state.decisions.map(({paperFillId,...d}:any)=>d)];
  for(const k of await s.redis.keys())if(k.includes(':owner:'))await s.redis.del(k);
  for(const x of agents){const key=await stateKeyOf(s,x.id),base=key.slice(0,-(':state:'+x.id).length);
    await s.redis.del(key);await s.redis.del(base+':rev:'+x.id);await s.redis.set(base+':records:'+x.id,JSON.stringify(legacy));}
  return {agents,hash,legacy};
}
const total=async(s:Setup,agents:{id:string;login:string}[],which?:any)=>{
  const rows=await Promise.all(agents.map(x=>live(s,x.id,x.login,which??s.make())));
  return {purchases:rows.reduce((n,r)=>n+r.confirmedPurchases,0),cost:rows.reduce((n,r)=>n+BigInt(r.costBasisAtoms??0),0n),complete:rows.every(r=>r.complete)};
};

test('older states holding the same confirmed purchase are reconciled to one count, idempotently and concurrently',async()=>{
  const s=setup(),{agents,hash}=await legacyDuplicate(s,[alice,alice,alice]);
  // Read concurrently through separate instances: each state is reconciled before it is shown.
  assert.deepEqual(await total(s,agents),{purchases:1,cost:250_000n,complete:true});
  const owners=await ownerOf(s,hash),statuses=(await Promise.all(agents.map(x=>proposalsOf(s,x.id)))).map(ps=>ps[0].status).sort();
  assert.deepEqual(statuses,['attributed-elsewhere','attributed-elsewhere','confirmed']);
  assert.ok(agents.some(x=>x.id===owners.agentId));
  // Repeated reconciliation (reads, a change, and a forced re-run) changes nothing.
  assert.deepEqual(await total(s,agents),{purchases:1,cost:250_000n,complete:true});
  for(const x of agents)await s.call(alice,'POST',`/api/agents/${x.id}/evaluate`,{forecast:forecast(s.f.manifest.pool)});
  for(const x of agents){const key=await stateKeyOf(s,x.id),state=JSON.parse((await s.redis.get(key))!);state.ownership=1;await s.redis.set(key,JSON.stringify(state));}
  assert.deepEqual(await total(s,agents),{purchases:1,cost:250_000n,complete:true});
  assert.deepEqual(await ownerOf(s,hash),owners,'ownership never moves');
  // The recovery evidence is kept on every proposal.
  for(const x of agents)assert.equal((await proposalsOf(s,x.id))[0].transactions[0].hash,hash);
});

test('older states in two accounts reconciled at the same moment count the purchase once',async()=>{
  const s=setup(),{agents}=await legacyDuplicate(s,[alice,bob]);
  const hold=holdOwnershipSaves(s,2);
  assert.deepEqual(await total(s,agents),{purchases:1,cost:250_000n,complete:true});
  hold.restore();
  assert.equal(hold.held(),2,'both reconciliations reached the atomic save together');
  assert.deepEqual(await total(s,agents),{purchases:1,cost:250_000n,complete:true});
});

test('totals rebuilt from a capped older list are reported as incomplete',async()=>{
  const s=setup(),{agents,legacy}=await legacyDuplicate(s,[alice]);
  const decision=legacy.find((r:any)=>r.kind==='decision');
  const full=[...legacy,...Array.from({length:100-legacy.length},(_,i)=>({...decision,id:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`}))];
  const key=(await s.redis.keys()).find(k=>k.endsWith(':records:'+agents[0].id))!;
  await s.redis.set(key,JSON.stringify(full));
  const result=await live(s,agents[0].id);
  assert.equal(result.complete,false);assert.ok(result.missing.some((m:string)=>/capped/.test(m)));
  assert.equal(result.confirmedPurchases,1,'what was kept is still counted once');
  assert.equal((await s.call(alice,'POST',`/api/agents/${agents[0].id}/performance`,{})).body.paper.complete,false);
});
