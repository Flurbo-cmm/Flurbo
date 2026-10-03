import assert from 'node:assert/strict';
import {test} from 'node:test';
import {privateKeyToAccount,generatePrivateKey} from 'viem/accounts';
import {encodeFunctionData,encodeAbiParameters,encodeEventTopics} from 'viem';
import {pilotPoolAbi,pilotCash,pilotCashAbi} from '../shared/pilot.mjs';
import {alice,bob,setup,forecast} from './agent-fixture.ts';
import {owner} from './pilot-fixture.ts';
import {settlementSources} from '../shared/settlement-sources.mjs';

// Hosted side of the autonomous agent platform: credentials, wallet association, the headless runtime API
// and verification of transactions a runtime signed itself. The fake chain answers the reads; signatures
// are real (viem), keys are random test keys.
type Setup=ReturnType<typeof setup>;
const ALL=['markets:read','wallet:read','runtime:report','executions:report'];
async function runtimeAgent(s:Setup,login=alice,name='Autonomous agent'){
  const r=await s.call(login,'POST','/api/agents',{kind:'runtime',name,markets:['pilot']});
  assert.equal(r.status,200,JSON.stringify(r.body));return r.body;
}
async function credential(s:Setup,id:string,scopes=ALL,login=alice,extra:Record<string,unknown>={}){
  const r=await s.call(login,'POST',`/api/agents/${id}/credentials`,{scopes,...extra});
  assert.equal(r.status,200,JSON.stringify(r.body));return r.body as {token:string;credential:any};
}
const rt=(s:Setup,token:string|null,method:string,path:string,body?:unknown,headers:Record<string,string>={},which=s.api)=>which.runtime({method,path:'/api/agent-runtime/v1/'+path,
  headers:{...(token?{authorization:'Bearer '+token}:{}),'flurbo-agent-protocol':'1',...headers},body:body===undefined?'':JSON.stringify(body)});
async function associate(s:Setup,id:string,key=generatePrivateKey(),login=alice){
  const wallet=privateKeyToAccount(key);
  const challenge=(await s.call(login,'POST',`/api/agents/${id}/wallet/challenge`,{wallet:wallet.address})).body;
  assert.ok(challenge.message?.includes('It does not move funds'),JSON.stringify(challenge));
  const verified=await s.call(login,'POST',`/api/agents/${id}/wallet/verify`,{id:challenge.id,signature:await wallet.signMessage({message:challenge.message})});
  assert.equal(verified.status,200,JSON.stringify(verified.body));
  return {wallet,key,challenge};
}

test('credentials: shown once, stored as a digest, scoped, expiring, rotatable, revocable and rate limited',async()=>{
  const s=setup(),agent=await runtimeAgent(s),{token,credential:c}=await credential(s,agent.id,['markets:read','runtime:report'],alice,{ttlDays:7,label:'laptop'});
  assert.match(token,/^fla1_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
  const secret=token.match(/^fla1_[0-9a-f]{16}_([A-Za-z0-9_-]{43})$/)![1];
  const stored=(await s.redis.keys()).map(async k=>await s.redis.get(k));
  for(const v of await Promise.all(stored))assert.ok(!String(v).includes(secret),'the secret is never stored');
  const listed=(await s.call(alice,'GET',`/api/agents/${agent.id}`)).body.runtime.credentials;
  assert.equal(listed.length,1);assert.equal(listed[0].status,'active');assert.ok(!JSON.stringify(listed).includes(secret));
  // Authentication and scopes.
  const session=await rt(s,token,'GET','session');
  assert.equal(session.status,200);assert.equal(session.body.agentId,agent.id);assert.deepEqual(session.body.credential.scopes,['markets:read','runtime:report']);
  assert.equal((await rt(s,token,'POST','markets/pilot/wallet',{claims:[]})).body.code,'SCOPE_REQUIRED');
  assert.equal((await rt(s,token.slice(0,-1)+(token.endsWith('A')?'B':'A'),'GET','session')).body.code,'UNAUTHENTICATED','wrong secret');
  assert.equal((await rt(s,'not-a-token','GET','session')).body.code,'UNAUTHENTICATED');
  assert.equal((await rt(s,null,'GET','session')).body.code,'UNAUTHENTICATED');
  assert.equal((await rt(s,token,'GET','session',undefined,{'flurbo-agent-protocol':'2'})).body.code,'UNSUPPORTED_PROTOCOL');
  assert.equal((await rt(s,token,'GET','session',undefined,{'sec-fetch-site':'same-origin','sec-fetch-mode':'cors'})).body.code,'BROWSER_NOT_SUPPORTED');
  assert.equal((await rt(s,token,'GET','session',undefined,{'sec-fetch-mode':'cors'})).status,200,'Node fetch sends only Sec-Fetch-Mode and is not a browser');
  // Expiry.
  s.advance(7*86_400);
  assert.equal((await rt(s,token,'GET','session')).body.code,'CREDENTIAL_EXPIRED');
  s.advance(-7*86_400);
  // Rotation revokes the old credential in the same step; the new one works.
  const rotated=(await s.call(alice,'POST',`/api/agents/${agent.id}/credentials/${c.credentialId}/rotate`,{})).body;
  assert.equal((await rt(s,token,'GET','session')).body.code,'CREDENTIAL_REVOKED');
  assert.equal((await rt(s,rotated.token,'GET','session')).status,200);
  assert.deepEqual(rotated.credential.scopes,['markets:read','runtime:report']);
  // Revocation takes effect for the next request.
  assert.equal((await s.call(alice,'POST',`/api/agents/${agent.id}/credentials/${rotated.credential.credentialId}/revoke`,{})).body.status,'revoked');
  assert.equal((await rt(s,rotated.token,'GET','session')).body.code,'CREDENTIAL_REVOKED');
  // At most five active credentials per agent.
  for(let i=0;i<5;i++)await credential(s,agent.id);
  assert.equal((await s.call(alice,'POST',`/api/agents/${agent.id}/credentials`,{scopes:ALL})).body.code,'CREDENTIAL_LIMIT');
  // Invalid scopes and lifetimes.
  assert.equal((await s.call(alice,'POST',`/api/agents/${agent.id}/credentials`,{scopes:['settlement:write']})).status,400);
  assert.equal((await s.call(alice,'POST',`/api/agents/${agent.id}/credentials`,{scopes:ALL,ttlDays:91})).status,400);
  // Rate limit per credential per minute.
  const agent2=await runtimeAgent(s,alice,'Rate agent'),{token:busy}=await credential(s,agent2.id);
  let limited=null;
  for(let i=0;i<125&&!limited;i++){const r=await rt(s,busy,'GET','session');if(r.status===429)limited=r;}
  assert.ok(limited,'the 121st request in a minute is refused');assert.equal(limited.body.code,'RATE_LIMITED');assert.ok(limited.retryAfter>0);
});

test('credentials are isolated by account, re-check testnet approval, and archived agents only report',async()=>{
  const s=setup(),agent=await runtimeAgent(s),{token,credential:c}=await credential(s,agent.id);
  // Another account cannot issue, list, revoke or rotate this agent's credentials.
  assert.equal((await s.call(bob,'POST',`/api/agents/${agent.id}/credentials`,{scopes:ALL})).status,404);
  assert.equal((await s.call(bob,'POST',`/api/agents/${agent.id}/credentials/${c.credentialId}/revoke`,{})).status,404);
  assert.equal((await s.call(bob,'GET',`/api/agents/${agent.id}`)).status,404);
  assert.equal((await rt(s,token,'GET','session')).status,200,'still valid after the attempts');
  // Approval removed: the next request is refused.
  let approved=true;const gated=s.make({previewAllows:async(account:string)=>approved&&account===alice.toLowerCase()});
  assert.equal((await rt(s,token,'GET','session',undefined,{},gated)).status,200);
  approved=false;
  assert.equal((await rt(s,token,'GET','session',undefined,{},gated)).body.code,'INVITE_REQUIRED');
  // An assisted (manual) agent cannot receive a runtime credential.
  const manual=(await s.call(alice,'POST','/api/agents',{name:'Manual agent',namespace:'pilot',mode:'paper'})).body;
  assert.equal((await s.call(alice,'POST',`/api/agents/${manual.id}/credentials`,{scopes:ALL})).status,404);
  // Archived: new work is refused, reporting and the session remain.
  assert.equal((await s.call(alice,'POST',`/api/agents/${agent.id}/delete`,{})).status,200);
  assert.equal((await rt(s,token,'GET','deployments')).body.code,'AGENT_ARCHIVED');
  assert.equal((await rt(s,token,'POST','heartbeat',{})).body.code,'AGENT_ARCHIVED');
  assert.equal((await rt(s,token,'GET','session')).body.status,'archived');
});

test('wallet association: fresh, domain-bound, single use, bound to account and agent, exclusive, with history',async()=>{
  const s=setup(),agent=await runtimeAgent(s),key=generatePrivateKey(),wallet=privateKeyToAccount(key);
  const challenge=(await s.call(alice,'POST',`/api/agents/${agent.id}/wallet/challenge`,{wallet:wallet.address})).body;
  assert.match(challenge.message,new RegExp(`Agent: ${agent.id}`));assert.match(challenge.message,/Origin: https:\/\/flurbo\.singu\.online/);
  // A signature from another key is rejected, and the challenge is spent.
  const intruder=privateKeyToAccount(generatePrivateKey());
  assert.equal((await s.call(alice,'POST',`/api/agents/${agent.id}/wallet/verify`,{id:challenge.id,signature:await intruder.signMessage({message:challenge.message})})).status,400);
  assert.equal((await s.call(alice,'POST',`/api/agents/${agent.id}/wallet/verify`,{id:challenge.id,signature:await wallet.signMessage({message:challenge.message})})).status,400,'single use, even after a rejection');
  // Another account cannot use Alice's challenge.
  const fresh=(await s.call(alice,'POST',`/api/agents/${agent.id}/wallet/challenge`,{wallet:wallet.address})).body;
  assert.equal((await s.call(bob,'POST',`/api/agents/${agent.id}/wallet/verify`,{id:fresh.id,signature:await wallet.signMessage({message:fresh.message})})).status,404);
  // Nor a different signed-in session of the same account.
  const other=await s.api.handle({method:'POST',path:`/api/agents/${agent.id}/wallet/verify`,input:{id:(await s.call(alice,'POST',`/api/agents/${agent.id}/wallet/challenge`,{wallet:wallet.address})).body.id,signature:'0x'+'11'.repeat(65)},
    login:{address:alice,method:'passkey'},origin:'https://flurbo.singu.online',sessionDigest:'another-session'});
  assert.equal(other.status,400);
  // Expired.
  const late=(await s.call(alice,'POST',`/api/agents/${agent.id}/wallet/challenge`,{wallet:wallet.address})).body;
  s.advance(301);
  assert.equal((await s.call(alice,'POST',`/api/agents/${agent.id}/wallet/verify`,{id:late.id,signature:await wallet.signMessage({message:late.message})})).status,400);
  // A valid proof associates the wallet.
  const good=(await s.call(alice,'POST',`/api/agents/${agent.id}/wallet/challenge`,{wallet:wallet.address})).body;
  const ok=await s.call(alice,'POST',`/api/agents/${agent.id}/wallet/verify`,{id:good.id,signature:await wallet.signMessage({message:good.message})});
  assert.equal(ok.status,200);assert.equal(ok.body.wallet,wallet.address.toLowerCase());
  // Exclusive across accounts and agents.
  const bobs=await runtimeAgent(s,bob,'Bob agent');
  assert.equal((await s.call(bob,'POST',`/api/agents/${bobs.id}/wallet/challenge`,{wallet:wallet.address})).status,409);
  // Policy refusals: the Mera account address, a linked MetaMask wallet, reserved operator addresses.
  assert.equal((await s.call(alice,'POST',`/api/agents/${agent.id}/wallet/challenge`,{wallet:alice})).status,400);
  assert.equal((await s.call(alice,'POST',`/api/agents/${agent.id}/wallet/challenge`,{wallet:owner})).status,400);
  const reserved=s.make({reservedWallets:new Set([s.f.manifest.pool])});
  assert.equal((await s.call(alice,'POST',`/api/agents/${agent.id}/wallet/challenge`,{wallet:s.f.manifest.pool},reserved)).status,400);
  // Replacement closes the old association and keeps it in the history; archive frees the wallet.
  const second=await associate(s,agent.id);
  const detail=(await s.call(alice,'GET',`/api/agents/${agent.id}`)).body.runtime;
  assert.equal(detail.wallet,second.wallet.address.toLowerCase());
  assert.deepEqual(detail.walletHistory.map((w:any)=>[w.address,w.until===null]),[[wallet.address.toLowerCase(),false],[second.wallet.address.toLowerCase(),true]]);
  assert.equal((await s.call(bob,'POST',`/api/agents/${bobs.id}/wallet/challenge`,{wallet:wallet.address})).status,200,'the replaced wallet is free again');
  await s.call(alice,'POST',`/api/agents/${agent.id}/delete`,{});
  assert.equal((await s.call(bob,'POST',`/api/agents/${bobs.id}/wallet/challenge`,{wallet:second.wallet.address})).status,200,'archiving frees the wallet');
  assert.equal(await s.api.isAgentWallet(second.wallet.address.toLowerCase()),false);
});

test('runtime reads: deployment record, market detail, quotes and the associated wallet state',async()=>{
  const s=setup(),agent=await runtimeAgent(s),{token}=await credential(s,agent.id);
  const deployments=(await rt(s,token,'GET','deployments')).body.deployments;
  assert.equal(deployments.length,1);
  const d=deployments[0];
  assert.deepEqual([d.schema,d.interface,d.chainId,d.pool,d.collateral.address,d.collateral.decimals,d.limits.slippageBps],
    ['flurbo.agent-deployment.v1','flurbo.pilot-pool.v1',10143,s.f.manifest.pool,pilotCash,6,[10,50,100]]);
  const market=(await rt(s,token,'GET','markets/pilot')).body;
  assert.equal(market.events.length,3);assert.ok(market.events[0].question);assert.ok('yesRule' in market.events[0]);
  // Every question carries the exact source settlement reads (or null), matching the shared derivation the market page uses.
  assert.deepEqual(market.events.map((e:any)=>e.settlement),settlementSources(s.f.manifest));
  assert.equal((await rt(s,token,'GET','markets/practice-'+'ab'.repeat(20))).status,404,'only enabled markets');
  const quote=(await rt(s,token,'POST','markets/pilot/quote',{side:'buy',scope:3,mask:'8',quantityAtoms:'1000000'})).body;
  assert.equal(quote.status,'ok');assert.equal(quote.quote.source,'pool.quoteBuy');
  assert.equal((await rt(s,token,'POST','markets/pilot/quote',{side:'buy',scope:3,mask:'15',quantityAtoms:'1000000'})).status,400,'a claim paying in every state');
  assert.equal((await rt(s,token,'POST','markets/pilot/wallet',{claims:[]})).body.code,'WALLET_REQUIRED');
  const {wallet}=await associate(s,agent.id);
  const state=(await rt(s,token,'POST','markets/pilot/wallet',{claims:[{scope:3,mask:'8'}]})).body;
  assert.deepEqual([state.wallet,state.collateralAtoms,state.nativeBalanceWei,state.holdings[0].quantityAtoms],[wallet.address.toLowerCase(),'100000000','1000000000000000000','1000000']);
});

test('heartbeats, policy acknowledgement and pause are visible to the owner, and decisions are labelled self-reported',async()=>{
  const s=setup(),agent=await runtimeAgent(s),{token}=await credential(s,agent.id);
  let view=(await s.call(alice,'GET',`/api/agents/${agent.id}`)).body.runtime;
  assert.equal(view.connection.state,'never');
  const beat={runtimeId:'rt-1',sdk:{language:'typescript',version:'0.2.0'},mode:'live',state:'running',policy:{hash:'a'.repeat(64),flurboVersion:1,summary:{maxTradeCostAtoms:'2000000'}},pending:0,startedAt:s.clock()};
  const ack=(await rt(s,token,'POST','heartbeat',beat)).body;
  assert.deepEqual([ack.version,ack.paused,ack.liveEnabled,ack.acknowledged],[1,false,false,true]);
  view=(await s.call(alice,'GET',`/api/agents/${agent.id}`)).body.runtime;
  assert.deepEqual([view.connection.state,view.acknowledged],['connected',true]);
  // Pausing publishes a new policy version; the runtime's acknowledgement lags until it reports it.
  const paused=(await s.call(alice,'POST',`/api/agents/${agent.id}/runtime-policy`,{paused:true,liveEnabled:true,maxTradeCostAtoms:'1500000',windows:[{seconds:3600,atoms:'5000000'}]})).body;
  assert.deepEqual([paused.version,paused.paused,paused.liveEnabled,paused.limits.maxTradeCostAtoms],[2,true,true,'1500000']);
  assert.equal((await rt(s,token,'GET','policy')).body.paused,true);
  view=(await s.call(alice,'GET',`/api/agents/${agent.id}`)).body.runtime;
  assert.equal(view.acknowledged,false,'the runtime has not reported the new version yet');
  await rt(s,token,'POST','heartbeat',{...beat,state:'paused',policy:{...beat.policy,flurboVersion:2}});
  assert.equal((await s.call(alice,'GET',`/api/agents/${agent.id}`)).body.runtime.acknowledged,true);
  s.advance(100);assert.equal((await s.call(alice,'GET',`/api/agents/${agent.id}`)).body.runtime.connection.state,'stale');
  s.advance(600);assert.equal((await s.call(alice,'GET',`/api/agents/${agent.id}`)).body.runtime.connection.state,'disconnected');
  // A runtime that reports its own stop is shown as stopped at once, not as connected.
  await rt(s,token,'POST','heartbeat',{...beat,state:'stopped',policy:{...beat.policy,flurboVersion:2}});
  assert.equal((await s.call(alice,'GET',`/api/agents/${agent.id}`)).body.runtime.connection.state,'stopped');
  s.advance(700);assert.equal((await s.call(alice,'GET',`/api/agents/${agent.id}`)).body.runtime.connection.state,'stopped');
  assert.equal((await s.call(alice,'POST',`/api/agents/${agent.id}/runtime-policy`,{maxTradeCostAtoms:'100000001'})).status,400);
  // Decisions.
  const decision={schema:'flurbo.agent-runtime-decision.v1',decisionId:'d-1',namespace:'pilot',createdAt:s.clock(),outcome:'abstain',reasons:['insufficient_evidence'],provenance:{kind:'model',name:'example/model'},summary:'Abstained: no fresh evidence.'};
  const stored=(await rt(s,token,'POST','decisions',decision)).body;
  assert.equal(stored.selfReported,true);
  assert.equal((await rt(s,token,'POST','decisions',decision)).body.receivedAt,stored.receivedAt,'idempotent by decision id');
  assert.equal((await rt(s,token,'POST','decisions',{...decision,decisionId:'d-2',outcome:'send_all_funds'})).status,400);
  assert.equal((await s.call(alice,'GET',`/api/agents/${agent.id}`)).body.runtime.decisions[0].decisionId,'d-1');
});

// Transactions signed and broadcast by the runtime itself.
const traded=(s:Setup,trader:string,amount=250_000n)=>[{address:s.f.manifest.pool,topics:encodeEventTopics({abi:pilotPoolAbi,eventName:'Traded',args:{trader:trader as `0x${string}`,scope:3,mask:8n}}),
  data:encodeAbiParameters([{type:'bool'},{type:'uint128'},{type:'uint128'}],[true,1_000_000n,amount])}];
const buyIntent={action:'buy',claim:{scope:3,mask:'8'},quantityAtoms:'1000000',limitAtoms:'260000',deadline:1_800_000_300};
const buyTx=(s:Setup,from:string)=>({from,to:s.f.manifest.pool,data:encodeFunctionData({abi:pilotPoolAbi,functionName:'buy',args:[3,8n,1_000_000n,260_000n,1_800_000_300n]})});

test('externally signed executions: provisional until verified, attributed once, with explicit provenance and accounting',async()=>{
  const s=setup(),agent=await runtimeAgent(s),{token}=await credential(s,agent.id),{wallet}=await associate(s,agent.id);
  const from=wallet.address.toLowerCase(),hash='0x'+'a1'.repeat(32);
  // Reported before the network shows it: recorded, nothing counted.
  let r=(await rt(s,token,'POST','executions',{namespace:'pilot',hash,intent:buyIntent,decisionId:'d-1'})).body;
  assert.equal(r.status,'recorded');assert.equal(r.provenance,'sdk-runtime');
  s.seen(buyTx(s,from),hash);
  assert.equal((await rt(s,token,'GET','executions/'+hash)).body.status,'pending');
  s.mine(buyTx(s,from),hash,{logs:traded(s,from)});
  r=(await rt(s,token,'GET','executions/'+hash)).body;
  assert.equal(r.status,'confirmed');assert.equal(r.verification.collateralAtoms,'250000');assert.equal(r.verification.from,from);
  let totals=(await s.call(alice,'GET',`/api/agents/${agent.id}`)).body.runtime.totals;
  assert.deepEqual([totals.buys,totals.buyCostAtoms],[1,'250000']);
  // Reporting again is a no-op; a different intent for the same hash is refused; nothing is counted twice.
  assert.equal((await rt(s,token,'POST','executions',{namespace:'pilot',hash,intent:buyIntent})).body.status,'confirmed');
  assert.equal((await rt(s,token,'POST','executions',{namespace:'pilot',hash,intent:{...buyIntent,limitAtoms:'270000'}})).body.code,'HASH_CONFLICT');
  assert.equal((await s.call(alice,'POST',`/api/agents/${agent.id}/executions/${hash}/check`,{})).body.status,'confirmed');
  totals=(await s.call(alice,'GET',`/api/agents/${agent.id}`)).body.runtime.totals;
  assert.deepEqual([totals.buys,totals.buyCostAtoms],[1,'250000']);
  // Another agent (another account) reporting the same transaction does not get it.
  const other=await runtimeAgent(s,bob,'Copycat'),{token:t2}=await credential(s,other.id,ALL,bob);await associate(s,other.id,generatePrivateKey(),bob);
  assert.equal((await rt(s,t2,'POST','executions',{namespace:'pilot',hash,intent:buyIntent})).body.code,'HASH_CONFLICT');
});

test('executions that are not this agent\'s verified intent are never counted as purchases',async()=>{
  const s=setup(),agent=await runtimeAgent(s),{token}=await credential(s,agent.id),{wallet}=await associate(s,agent.id);
  const from=wallet.address.toLowerCase(),stranger=privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
  const report=async(hash:string,intent:any=buyIntent)=>(await rt(s,token,'POST','executions',{namespace:'pilot',hash,intent})).body;
  // From a wallet that is not the agent's.
  s.mine(buyTx(s,stranger),'0x'+'b1'.repeat(32),{logs:traded(s,stranger)});
  let r=await report('0x'+'b1'.repeat(32));assert.deepEqual([r.status,r.verification.reason],['mismatch','wallet_not_associated']);
  // The call differs from the reported intent.
  s.mine(buyTx(s,from),'0x'+'b2'.repeat(32),{logs:traded(s,from)});
  r=await report('0x'+'b2'.repeat(32),{...buyIntent,limitAtoms:'250000'});assert.deepEqual([r.status,r.verification.reason],['mismatch','intent_mismatch']);
  // Paid more than the limit according to the event: effect missing.
  s.mine(buyTx(s,from),'0x'+'b3'.repeat(32),{logs:traded(s,from,260_001n)});
  r=await report('0x'+'b3'.repeat(32));assert.deepEqual([r.status,r.verification.reason],['mismatch','effect_missing']);
  // A reverted purchase.
  s.mine(buyTx(s,from),'0x'+'b4'.repeat(32),{status:'0x0'});
  assert.equal((await report('0x'+'b4'.repeat(32))).status,'reverted');
  // A call outside the pool policy (approval to another spender).
  s.mine({from,to:pilotCash,data:encodeFunctionData({abi:pilotCashAbi,functionName:'approve',args:[bob as `0x${string}`,260_000n]})},'0x'+'b5'.repeat(32));
  r=await report('0x'+'b5'.repeat(32),{action:'approve',claim:null,quantityAtoms:'0',limitAtoms:'260000',deadline:null});assert.equal(r.status,'mismatch');
  // Sent before the wallet was associated with this agent (block time earlier than the association).
  s.mine(buyTx(s,from),'0x'+'b6'.repeat(32),{logs:traded(s,from),block:'0x6a',timestamp:s.clock()-10});
  r=await report('0x'+'b6'.repeat(32));assert.deepEqual([r.status,r.verification.reason],['mismatch','wallet_not_associated']);
  const totals=(await s.call(alice,'GET',`/api/agents/${agent.id}`)).body.runtime.totals;
  assert.deepEqual([totals.buys,totals.buyCostAtoms,totals.reverted,totals.mismatched],[0,'0',1,5]);
  // Malformed reports.
  assert.equal((await rt(s,token,'POST','executions',{namespace:'pilot',hash:'0x1234',intent:buyIntent})).status,400);
  assert.equal((await rt(s,token,'POST','executions',{namespace:'pilot',hash:'0x'+'c1'.repeat(32),intent:{...buyIntent,action:'dispute'}})).status,400);
});

test('an execution survives wallet replacement and archive, and one transaction never counts in two flows',async()=>{
  const s=setup(),agent=await runtimeAgent(s),{token}=await credential(s,agent.id),{wallet}=await associate(s,agent.id);
  // A browser proposal prepared meanwhile, in an assisted agent.
  s.f.options.allowance=10n**12n;
  const assistedAgent=(await s.call(alice,'POST','/api/agents',{name:'Assisted',namespace:'pilot',mode:'approval'})).body;
  const decision=(await s.call(alice,'POST',`/api/agents/${assistedAgent.id}/evaluate`,{forecast:forecast(s.f.manifest.pool)})).body;
  const proposal=(await s.call(alice,'POST',`/api/agents/${assistedAgent.id}/proposal`,{decisionId:decision.id,owner})).body;
  assert.equal(proposal.status,'awaiting-approval');
  const from=wallet.address.toLowerCase(),hash='0x'+'d1'.repeat(32);
  s.mine(buyTx(s,from),hash,{logs:traded(s,from),block:'0x6b',timestamp:s.clock()+5});
  await rt(s,token,'POST','executions',{namespace:'pilot',hash,intent:buyIntent});
  s.advance(60);await associate(s,agent.id);
  assert.equal((await rt(s,token,'GET','executions/'+hash)).body.status,'confirmed','attributed by the wallet associated at block time');
  // The ownership namespace is shared with browser proposals: the proposal cannot record this transaction.
  const claimed=await s.call(alice,'POST',`/api/agents/${assistedAgent.id}/proposals/${proposal.id}`,{action:'submitted',hash,transaction:proposal.review.transaction});
  assert.equal(claimed.status,409);assert.equal(claimed.body.code,'HASH_CONFLICT');
  await s.call(alice,'POST',`/api/agents/${agent.id}/delete`,{});
  assert.equal((await rt(s,token,'GET','executions/'+hash)).body.status,'confirmed','still readable after archive');
  assert.equal((await rt(s,token,'POST','executions',{namespace:'pilot',hash:'0x'+'d2'.repeat(32),intent:buyIntent})).body.status,'recorded','archived agents can still report sent transactions');
});

test('agents start with published default live limits, and allowing live trades never leaves an agent without them',async()=>{
  const s=setup(),agent=await runtimeAgent(s);
  const view=async()=>(await s.call(alice,'GET',`/api/agents/${agent.id}`)).body.runtime.policy;
  const DEFAULTS={maxTradeCostAtoms:'2000000',windows:[{seconds:86400,atoms:'10000000'}]};
  assert.deepEqual((await view()).limits,DEFAULTS,'a new agent has 2 test AUSD per trade and 10 per 24 hours');
  // An owner can remove Flurbo's limits while live trading is off; turning live on then restores the defaults.
  await s.call(alice,'POST',`/api/agents/${agent.id}/runtime-policy`,{maxTradeCostAtoms:null,windows:[]});
  assert.deepEqual((await view()).limits,{maxTradeCostAtoms:null,windows:[]});
  await s.call(alice,'POST',`/api/agents/${agent.id}/runtime-policy`,{liveEnabled:true});
  const live=await view();
  assert.equal(live.liveEnabled,true);assert.deepEqual(live.limits,DEFAULTS);
  // Limits chosen in the same request, or changed once live, are kept as chosen.
  await s.call(alice,'POST',`/api/agents/${agent.id}/runtime-policy`,{maxTradeCostAtoms:'5000000'});
  assert.equal((await view()).limits.maxTradeCostAtoms,'5000000');
  const other=await runtimeAgent(s,alice,'Second agent');
  await s.call(alice,'POST',`/api/agents/${other.id}/runtime-policy`,{liveEnabled:true,maxTradeCostAtoms:'3000000',windows:[]});
  assert.deepEqual((await s.call(alice,'GET',`/api/agents/${other.id}`)).body.runtime.policy.limits,{maxTradeCostAtoms:'3000000',windows:[]});
});

test('heartbeats are shown at once but written to Redis only on a visible change or every 5 minutes',async()=>{
  const s=setup(),agent=await runtimeAgent(s),{token}=await credential(s,agent.id);
  let commands=0;const counted=s.make({command:async(...c:any[])=>{commands++;return s.redis.command(...c);},localCounters:true});
  const beat={runtimeId:'rt-1',sdk:{language:'typescript',version:'0.2.0'},mode:'paper',state:'running',policy:{hash:'a'.repeat(64),flurboVersion:1,summary:{}},pending:0,startedAt:s.clock()};
  const send=async(over:Record<string,unknown>={})=>{const before=commands;assert.equal((await rt(s,token,'POST','heartbeat',{...beat,...over},{},counted)).status,200);return commands-before;};
  const persisted=await send();
  const quiet:number[]=[];
  for(let i=0;i<9;i++){s.advance(30);quiet.push(await send());}
  assert.ok(quiet.every(n=>n<persisted/2),`unchanged beats skip the write: first ${persisted}, then ${quiet}`);
  const view=(await s.call(alice,'GET',`/api/agents/${agent.id}`,undefined,counted)).body.runtime;
  assert.equal(view.connection.state,'connected');assert.equal(view.heartbeats[0].receivedAt,s.clock(),'the dashboard shows the newest beat, not the stored one');
  s.advance(30);assert.ok(await send()>=persisted/2,'written again once the stored beat is 5 minutes old');
  s.advance(30);assert.ok(await send({state:'stopped'})>=persisted/2,'a stop is written at once');
  // Another server instance (or a restart) sees the stored stop.
  assert.equal((await s.call(alice,'GET',`/api/agents/${agent.id}`)).body.runtime.connection.state,'stopped');
});
