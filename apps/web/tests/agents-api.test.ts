import assert from 'node:assert/strict';
import {test} from 'node:test';
import {request as httpRequest} from 'node:http';
import {decodeFunctionData,encodeAbiParameters,encodeEventTopics,encodeFunctionData} from 'viem';
import {alice,bob,origin,fakeRedis,setup,forecast} from './agent-fixture.ts';
import {DEFAULT_PROFILE_CONFIG,proposalView} from '../server/agents/agent-api.mjs';
import {AGENT_LIMITS} from '../server/agents/agent-store.mjs';
import {pilotPoolAbi} from '../shared/pilot.mjs';
import {previewAccess} from '../server/preview-access.mjs';
import {TESTNET} from '../server/network.mjs';
import {productionServer} from '../server/production.mjs';
import {pilotFixture,owner} from './pilot-fixture.ts';

test('agents persist per account across restarts and cannot be read or changed by another account',async()=>{
  const s=setup();
  const created=await s.call(alice,'POST','/api/agents',{name:'Release watcher',namespace:'pilot',mode:'paper'});
  assert.equal(created.status,200);const id=created.body.id;
  assert.equal(created.body.market.pool,s.f.manifest.pool);assert.equal(created.body.status,'active');assert.deepEqual(created.body.config,DEFAULT_PROFILE_CONFIG);
  // A new API instance over the same durable store: the agent survives a refresh or deploy.
  const restarted=s.make();
  assert.equal((await s.call(alice,'GET','/api/agents',undefined,restarted)).body.agents[0].id,id);
  assert.equal((await s.call(alice,'GET','/api/agents',undefined,restarted)).body.durable,true);
  // Bob cannot see, read, change, evaluate or delete it. Not found, not forbidden, so ids leak nothing.
  assert.deepEqual((await s.call(bob,'GET','/api/agents')).body.agents,[]);
  for(const [method,path,input] of [['GET',`/api/agents/${id}`],['POST',`/api/agents/${id}/update`,{status:'paused'}],['POST',`/api/agents/${id}/delete`,{}],
    ['POST',`/api/agents/${id}/evaluate`,{forecast:forecast(s.f.manifest.pool)}],['POST',`/api/agents/${id}/performance`,{}]] as const)
    assert.equal((await s.call(bob,method,path,input)).status,404,path);
  assert.equal((await s.call(alice,'GET',`/api/agents/${id}`)).body.profile.status,'active');
  // Storage keys never contain the raw account address.
  assert.ok((await s.redis.keys()).every(k=>!k.includes(alice.slice(2))));
  assert.equal((await s.call(alice,'POST',`/api/agents/${id}/update`,{status:'paused',name:'Release watcher two'})).body.status,'paused');
  // Deleting archives: hidden from the list, refused for new work, still readable for recovery.
  assert.equal((await s.call(alice,'POST',`/api/agents/${id}/delete`,{})).body.deleted,true);
  const listed=(await s.call(alice,'GET','/api/agents')).body;
  assert.deepEqual(listed.agents,[]);assert.deepEqual(listed.archived.map((a:any)=>a.id),[id]);
  assert.equal((await s.call(alice,'GET',`/api/agents/${id}`)).body.profile.status,'archived');
  assert.equal((await s.call(alice,'POST',`/api/agents/${id}/update`,{status:'active'})).body.code,'ARCHIVED');
  assert.equal((await s.call(alice,'POST',`/api/agents/${id}/delete`,{})).status,404);
  assert.equal((await s.call(bob,'GET',`/api/agents/${id}`)).status,404);
});

test('profile input is validated and ownership never comes from the request',async()=>{
  const s=setup();
  for(const input of [{name:'x',namespace:'pilot',mode:'paper'},{name:'Valid name',namespace:'nowhere',mode:'paper'},{name:'Valid name',namespace:'pilot',mode:'autonomous'},
    {name:'Valid name',namespace:'pilot',mode:'paper',owner:alice},{name:'Valid name',namespace:'pilot',mode:'paper',config:{...DEFAULT_PROFILE_CONFIG,slippageBps:250}},
    {name:'Valid name',namespace:'pilot',mode:'paper',config:{...DEFAULT_PROFILE_CONFIG,quantityAtoms:'1.5'}},{name:'Valid name',namespace:'pilot',mode:'paper',config:{...DEFAULT_PROFILE_CONFIG,maxCostAtoms:'0'}}])
    assert.equal((await s.call(alice,'POST','/api/agents',input)).status,400,JSON.stringify(input));
  assert.equal((await s.call(alice,'POST','/api/agents',{name:'Valid name',namespace:'practice-'+'99'.repeat(20),mode:'paper'})).status,404);
  // Names can carry the SDK they use, but nothing that could read as markup.
  for(const name of ['<b>bot</b>','bot"quoted"','a/b agent'])assert.equal((await s.call(alice,'POST','/api/agents',{name,namespace:'pilot',mode:'paper'})).status,400,name);
  const cpp=await s.call(alice,'POST','/api/agents',{name:'e2e C++ agent',namespace:'pilot',mode:'paper'});
  assert.equal(cpp.status,200);assert.equal(cpp.body.name,'e2e C++ agent');
  assert.equal((await s.call(alice,'POST',`/api/agents/${cpp.body.id}/update`,{name:"C# bot (Anna's test)"})).status,200);
  await s.call(alice,'POST',`/api/agents/${cpp.body.id}/delete`,{});
  for(let i=0;i<AGENT_LIMITS.agents;i++)assert.equal((await s.call(alice,'POST','/api/agents',{name:`Agent ${i}`,namespace:'pilot',mode:'paper'})).status,200);
  assert.equal((await s.call(alice,'POST','/api/agents',{name:'One too many',namespace:'pilot',mode:'paper'})).status,409);
});

test('evaluation records a reproducible decision from server-read quotes; unsupported and cross-pool input is rejected',async()=>{
  const s=setup(),pool=s.f.manifest.pool;
  const id=(await s.call(alice,'POST','/api/agents',{name:'Pair agent',namespace:'pilot',mode:'paper'})).body.id;
  const record=(await s.call(alice,'POST',`/api/agents/${id}/evaluate`,{forecast:forecast(pool)})).body;
  assert.equal(record.kind,'decision');assert.equal(record.decision.outcome,'propose');
  assert.equal(record.forecast.source.kind,'user','the server cannot verify a claimed provider, so it records the user');
  assert.equal(record.decision.snapshot.blockHash,'0x'+'44'.repeat(32));
  assert.ok(record.decision.evaluations.every((e:any)=>e.quoteAtoms==='250000'),'every candidate priced by the pool contract at the snapshot');
  const again=(await s.call(alice,'POST',`/api/agents/${id}/evaluate`,{forecast:forecast(pool)})).body;
  assert.deepEqual(again.decision,record.decision,'same snapshot, forecast and settings give the same decision');
  assert.equal((await s.call(alice,'POST',`/api/agents/${id}/evaluate`,{forecast:forecast('0x'+'99'.repeat(20))})).status,400);
  assert.equal((await s.call(alice,'POST',`/api/agents/${id}/evaluate`,{forecast:forecast(pool,{joint:{events:[0,1],statesPpm:['500000','500000','500000','0']}})})).status,400);
  assert.equal((await s.call(alice,'POST',`/api/agents/${id}/evaluate`,{forecast:forecast(pool),extra:true})).status,400);
  const unsupported=await s.call(alice,'POST','/api/agents/quote',{namespace:'pilot',scope:7,mask:'255',quantityAtoms:'1000000',side:'buy'});
  assert.deepEqual([unsupported.body.status,unsupported.body.reason],['unavailable','unsupported_claim']);
  const tooBig=await s.call(alice,'POST','/api/agents/quote',{namespace:'pilot',scope:1,mask:'2',quantityAtoms:'100000001',side:'buy'});
  assert.equal(tooBig.body.reason,'quantity_limit');
  await s.call(alice,'POST',`/api/agents/${id}/update`,{status:'paused'});
  assert.equal((await s.call(alice,'POST',`/api/agents/${id}/evaluate`,{forecast:forecast(pool)})).status,409);
});

test('evaluation is rate limited per account',async()=>{
  const s=setup(),pool=s.f.manifest.pool;
  const id=(await s.call(alice,'POST','/api/agents',{name:'Busy agent',namespace:'pilot',mode:'paper'})).body.id;
  for(let i=0;i<AGENT_LIMITS.evaluationsPerHour;i++)assert.equal((await s.call(alice,'POST',`/api/agents/${id}/evaluate`,{forecast:forecast(pool)})).status,200);
  const limited=await s.call(alice,'POST',`/api/agents/${id}/evaluate`,{forecast:forecast(pool)});
  assert.equal(limited.status,429);assert.equal(limited.body.code,'RATE_LIMITED');
});

test('agent and human quotes agree for the same claim, quantity and snapshot',async()=>{
  const s=setup();s.f.options.allowance=10n**12n;
  const quote=(await s.call(alice,'POST','/api/agents/quote',{namespace:'pilot',scope:3,mask:'8',quantityAtoms:'1000000',side:'buy'})).body;
  assert.equal(quote.status,'ok');assert.equal(quote.quote.source,'pool.quoteBuy');
  const review=await s.f.service.prepare({owner,action:'buy',scope:3,mask:'8',quantity:'1000000',slippageBps:50});
  assert.equal(review.snapshot.blockHash,quote.quote.snapshot.blockHash);
  const limit=(BigInt(quote.quote.amountAtoms)*10050n+9999n)/10000n;
  assert.equal(review.amountAtoms,limit.toString(),'the human review limit is exactly the agent quote plus the same slippage rule');
});

test('paper trades are labelled, budgeted and cannot reuse an unchanged or expired quote',async()=>{
  const s=setup(),pool=s.f.manifest.pool;
  const id=(await s.call(alice,'POST','/api/agents',{name:'Paper agent',namespace:'pilot',mode:'paper'})).body.id;
  const decision=(await s.call(alice,'POST',`/api/agents/${id}/evaluate`,{forecast:forecast(pool)})).body;
  const fill=await s.call(alice,'POST',`/api/agents/${id}/paper`,{decisionId:decision.id});
  assert.equal(fill.status,200);assert.equal(fill.body.fill.mode,'paper');assert.equal(fill.body.fill.costAtoms,'250000');
  assert.equal((await s.call(alice,'POST',`/api/agents/${id}/paper`,{decisionId:decision.id})).status,409);
  const sameBlock=(await s.call(alice,'POST',`/api/agents/${id}/evaluate`,{forecast:forecast(pool)})).body;
  assert.equal((await s.call(alice,'POST',`/api/agents/${id}/paper`,{decisionId:sameBlock.id})).status,409,'an unchanged quote cannot be filled twice');
  s.advance(61);
  const late=(await s.call(alice,'POST',`/api/agents/${id}/paper`,{decisionId:sameBlock.id}));
  assert.equal(late.status,409);
  const perf=(await s.call(alice,'POST',`/api/agents/${id}/performance`,{})).body;
  assert.equal(perf.paper.realized,null,'unresolved pool: nothing is realized');assert.equal(perf.paper.unrealized,null,'no sell quote: value unknown, not zero');
  assert.ok(perf.paper.missing.length>=2);assert.equal(perf.live.confirmedPurchases,0);assert.equal(perf.live.collectedPayoutAtoms,null);
});

test('proposals need approval mode and a linked wallet, preserve the claim, and only a verified purchase receipt confirms',async()=>{
  const s=setup(),pool=s.f.manifest.pool;
  const id=(await s.call(alice,'POST','/api/agents',{name:'Approval agent',namespace:'pilot',mode:'paper'})).body.id;
  const decision=(await s.call(alice,'POST',`/api/agents/${id}/evaluate`,{forecast:forecast(pool)})).body;
  const wanted=decision.decision.proposal;
  assert.equal((await s.call(alice,'POST',`/api/agents/${id}/proposal`,{decisionId:decision.id,owner})).status,409,'paper mode never prepares a transaction');
  await s.call(alice,'POST',`/api/agents/${id}/update`,{mode:'approval'});
  assert.equal((await s.call(alice,'POST',`/api/agents/${id}/proposal`,{decisionId:decision.id,owner:'0x'+'99'.repeat(20)})).status,403,'unlinked wallet');
  // No allowance yet: the first review is an exact token approval, which is not a purchase.
  const proposal=(await s.call(alice,'POST',`/api/agents/${id}/proposal`,{decisionId:decision.id,owner})).body;
  assert.equal(proposal.status,'awaiting-approval');assert.equal(proposal.review.action,'approve');
  assert.ok(BigInt(proposal.review.amountAtoms)<=BigInt(wanted.worstCostAtoms));
  const path=`/api/agents/${id}/proposals/${proposal.id}`;
  assert.equal((await s.call(alice,'POST',path,{action:'submitted',hash:'0xnot-a-hash',transaction:proposal.review.transaction})).status,400);
  const approvalHash='0x'+'a1'.repeat(32);
  assert.equal((await s.call(alice,'POST',path,{action:'submitted',hash:approvalHash,transaction:proposal.review.transaction})).body.status,'submitted');
  assert.equal((await s.call(alice,'POST',path,{action:'submitted',hash:'0x'+'a2'.repeat(32),transaction:proposal.review.transaction})).status,409,'one tracked transaction at a time');
  assert.equal((await s.call(alice,'POST',path,{action:'submitted',hash:approvalHash})).status,400,'the sent transaction is always named');
  assert.equal((await s.call(alice,'POST',path,{action:'check'})).body.check,'unknown','a hash alone is not execution');
  s.mine(proposal.review.transaction,approvalHash);
  const approved=(await s.call(alice,'POST',path,{action:'check'})).body;
  assert.equal(approved.status,'approval-confirmed','an approval receipt never marks a purchase confirmed');
  // Allowance now exists; refreshing prepares the purchase itself, carrying the exact claim and quantity.
  s.f.options.allowance=10n**12n;
  const buy=(await s.call(alice,'POST',path,{action:'refresh'})).body;
  assert.equal(buy.review.action,'buy');
  const args=decodeFunctionData({abi:pilotPoolAbi,data:buy.review.transaction.data}).args as any[];
  assert.deepEqual([args[0],args[1].toString(),args[2].toString()],[wanted.claim.scope,wanted.claim.mask,wanted.quantityAtoms]);
  assert.equal(args[3].toString(),buy.review.amountAtoms);
  const buyHash='0x'+'b1'.repeat(32);
  await s.call(alice,'POST',path,{action:'submitted',hash:buyHash,transaction:buy.review.transaction});
  const traded={address:pool,topics:encodeEventTopics({abi:pilotPoolAbi,eventName:'Traded',args:{trader:owner,scope:wanted.claim.scope,mask:BigInt(wanted.claim.mask)}}),
    data:encodeAbiParameters([{type:'bool'},{type:'uint128'},{type:'uint128'}],[true,BigInt(wanted.quantityAtoms),250_000n])};
  s.mine(buy.review.transaction,buyHash,{logs:[traded]});
  const confirmed=(await s.call(alice,'POST',path,{action:'check'})).body;
  assert.equal(confirmed.status,'confirmed');assert.equal(confirmed.transactions.at(-1).paidAtoms,'250000');
  const perf=(await s.call(alice,'POST',`/api/agents/${id}/performance`,{})).body;
  assert.equal(perf.live.confirmedPurchases,1);assert.equal(perf.live.costBasisAtoms,'250000');assert.equal(perf.live.realizedPnlAtoms,null);
  // Another account can never touch this proposal.
  assert.equal((await s.call(bob,'POST',path,{action:'check'})).status,404);
});

test('a mismatched or reverted transaction fails the proposal; rejection and expiry are explicit; price moves are refused',async()=>{
  const s=setup(),pool=s.f.manifest.pool;s.f.options.allowance=10n**12n;
  const id=(await s.call(alice,'POST','/api/agents',{name:'Strict agent',namespace:'pilot',mode:'approval'})).body.id;
  const decision=(await s.call(alice,'POST',`/api/agents/${id}/evaluate`,{forecast:forecast(pool)})).body;
  const first=(await s.call(alice,'POST',`/api/agents/${id}/proposal`,{decisionId:decision.id,owner})).body;
  const path=`/api/agents/${id}/proposals/${first.id}`;
  await s.call(alice,'POST',path,{action:'submitted',hash:'0x'+'c1'.repeat(32),transaction:first.review.transaction});
  s.mine({...first.review.transaction,data:first.review.transaction.data.slice(0,-2)+'00'},'0x'+'c1'.repeat(32));
  const mismatch=(await s.call(alice,'POST',path,{action:'check'})).body;
  assert.equal(mismatch.status,'failed');assert.match(mismatch.failure,/does not match/);
  const second=(await s.call(alice,'POST',`/api/agents/${id}/proposal`,{decisionId:decision.id,owner})).body;
  const duplicate=await s.call(alice,'POST',`/api/agents/${id}/proposal`,{decisionId:decision.id,owner});
  assert.equal(duplicate.status,409);assert.equal(duplicate.body.code,'PROPOSAL_EXISTS','one decision never yields two live proposals');
  await s.call(alice,'POST',`/api/agents/${id}/proposals/${second.id}`,{action:'submitted',hash:'0x'+'c2'.repeat(32),transaction:second.review.transaction});
  s.mine(second.review.transaction,'0x'+'c2'.repeat(32),{status:'0x0'});
  assert.equal((await s.call(alice,'POST',`/api/agents/${id}/proposals/${second.id}`,{action:'check'})).body.status,'failed');
  const third=(await s.call(alice,'POST',`/api/agents/${id}/proposal`,{decisionId:decision.id,owner})).body;
  assert.equal((await s.call(alice,'POST',`/api/agents/${id}/proposals/${third.id}`,{action:'rejected'})).body.status,'rejected');
  assert.equal(proposalView({...third,status:'awaiting-approval'},third.review.expiresAt).status,'expired');
  // Price moved: the fresh review limit exceeds what the decision allowed, so nothing is prepared.
  const original=s.f.service.prepare;
  s.f.service.prepare=async(input:any)=>{const review=await original(input);const args=decodeFunctionData({abi:pilotPoolAbi,data:review.transaction.data}).args as any[];
    const limit=BigInt(decision.decision.proposal.worstCostAtoms)+1n;
    return {...review,amountAtoms:limit.toString(),transaction:{...review.transaction,data:encodeFunctionData({abi:pilotPoolAbi,functionName:'buy',args:[args[0],args[1],args[2],limit,args[4]]})}};};
  const moved=await s.call(alice,'POST',`/api/agents/${id}/proposal`,{decisionId:decision.id,owner});
  assert.equal(moved.status,409);assert.equal(moved.body.code,'PRICE_MOVED');
});

test('hosted agent routes enforce sign-in and invite approval before any agent code runs',async()=>{
  const fixture=pilotFixture(),redis=fakeRedis();
  const policy=previewAccess({FLURBO_TESTNET_APPROVED_ACCOUNTS:alice});
  const store={command:redis.command,read:async(id:string)=>id==='approved'?{address:alice,method:'passkey'}:id==='pending'?{address:bob,method:'passkey'}:id==='wallet'?{address:alice,method:'wallet'}:null};
  const server=productionServer({origin,rpcUrl:TESTNET.rpc,previewAccess:policy,pilot:fixture.service,pilotEvidence:{get:async()=>'{}'}},store);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const request=(path:string,id='',body?:object):Promise<any>=>new Promise((resolve,reject)=>{
    const req=httpRequest({hostname:'127.0.0.1',port:(server.address() as any).port,path,method:body?'POST':'GET',headers:{host:'flurbo.singu.online',origin,'content-type':'application/json',cookie:'flurbo_session='+id}},
      res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,data:text?JSON.parse(text):null}));});
    req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
  });
  try{
    for(const [path,body] of [['/api/agents'],['/api/agents',{name:'Test agent',namespace:'pilot',mode:'paper'}],['/api/agents/quote',{namespace:'pilot',scope:1,mask:'2',quantityAtoms:'1000000',side:'buy'}]] as const){
      assert.equal((await request(path,'',body)).status,401,path);
      assert.equal((await request(path,'wallet',body)).status,401,path);
      const pending=await request(path,'pending',body);
      assert.equal(pending.status,403,path);assert.equal(pending.data.code,'INVITE_REQUIRED');
    }
    const listed=await request('/api/agents','approved');
    assert.equal(listed.status,200);assert.equal(listed.data.durable,true);
    assert.equal((await request('/api/agents?owner='+alice,'approved')).status,400);
    assert.equal((await request('/api/agents','approved',{name:'Hosted agent',namespace:'pilot',mode:'paper'})).status,200);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
