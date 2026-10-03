import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFunctionData, encodeFunctionData, encodeFunctionResult, keccak256, type Hex } from 'viem';
import { pilotService, pilotEvidence, pilotRpc } from '../server/pilot.mjs';
import { pilotCall, resolverAbi, pilotPoolAbi, pilotCashAbi, pilotCash } from '../shared/pilot.mjs';
import { submitPilot, validatePilotReview, rpcInteger } from '../src/pilot.ts';

import { owner, pool, resolver, hash, rules, pilotFixture } from './pilot-fixture.ts';

test('ticket quantity limit uses the deployed pool liquidity and the existing API cap',async()=>{
  const f=pilotFixture();
  assert.equal((await f.service.status()).maxTradeQuantityAtoms,'10000000');
  f.options.liquidity=5_000_000n;
  assert.equal((await f.service.status()).maxTradeQuantityAtoms,'5000000');
  f.options.liquidity=200_000_000n;
  assert.equal((await f.service.status()).maxTradeQuantityAtoms,'100000000');
});

test('pilot action policy rejects foreign targets, extra calldata, oversized approval and invalid evidence',()=>{
  const {manifest}=pilotFixture();
  const data=encodeFunctionData({abi:resolverAbi,functionName:'assertOutcome',args:[0,2,hash,'https://flurbo.singu.online/evidence']});
  assert.ok(pilotCall({to:resolver,data,manifest}));
  assert.equal(pilotCall({to:pool,data,manifest}),null);
  assert.equal(pilotCall({to:resolver,data:data+'00',manifest}),null);
  for(const args of [[2,2,hash,'https://valid.org/e'],[0,0,hash,'https://valid.org/e'],[0,2,hash,'javascript:alert(1)']])assert.equal(pilotCall({to:resolver,data:encodeFunctionData({abi:resolverAbi,functionName:'assertOutcome',args}),manifest}),null);
  assert.equal(pilotCall({to:pilotCash,data:encodeFunctionData({abi:pilotCashAbi,functionName:'approve',args:[resolver,2_000_000n]}),manifest}),null);
});

test('pilot prepares exact approval then bounded trade; changed deployment and simulation fail closed',async()=>{
  const f=pilotFixture(),input={owner,action:'buy',scope:3,mask:'8',quantity:'1000000',slippageBps:50};
  const approval=await f.service.prepare(input);assert.equal(approval.action,'approve');assert.equal(approval.amountAtoms,'251250');validatePilotReview(approval);
  f.options.allowance=1_000_000n;
  const trade=await f.service.prepare(input);assert.equal(trade.action,'buy');validatePilotReview(trade);
  assert.throws(()=>validatePilotReview({...trade,amountAtoms:'1'}),/limit/);
  const sale=await f.service.prepare({...input,action:'sell'});validatePilotReview(sale);
  assert.equal(sale.minimumReceivedAtoms,'247755');
  assert.throws(()=>validatePilotReview({...sale,minimumReceivedAtoms:'0'}),/limit/);
  f.options.failSimulation=true;await assert.rejects(f.service.prepare(input));f.options.failSimulation=false;
  f.options.changed=true;await assert.rejects(f.service.status(owner));f.options.changed=false;
  f.options.chain=143n;await assert.rejects(f.service.status(owner));
});

test('new evidence uploads are rate limited durably while existing content remains reusable',async()=>{
  const db=new Map<string,string>(),counts=new Map<string,number>();
  const command=async(...a:any[])=>{
    if(a[0]==='EVAL'){const value=(counts.get(a[3])||0)+1;counts.set(a[3],value);return value;}
    if(a[0]==='SET'){if(!db.has(a[1]))db.set(a[1],a[2]);return 'OK';}return db.get(a[1]);
  };
  const input={eventId:'a',outcome:2,statement:'Public test fixture evidence only.',sourceURL:'https://example.org/evidence',attachment:''};
  let service=pilotEvidence(command,'https://flurbo.singu.online',()=>0);
  const first=await service.put(input,owner,rules);
  for(let i=1;i<20;i++)await service.put({...input,attachment:String(i)},owner,rules);
  service=pilotEvidence(command,'https://flurbo.singu.online',()=>0);
  await assert.rejects(service.put({...input,attachment:'over quota'},owner,rules),/limit/);
  assert.equal((await service.put(input,owner,rules)).hash,first.hash);
  assert.equal(await service.get(first.hash),first.body);
});

test('pilot evidence persists immutable bytes across service reconstruction and detects corruption',async()=>{
  const db=new Map<string,string>(),command=async(...a:any[])=>{if(a[0]==='EVAL')return 1;if(a[0]==='SET'){if(!db.has(a[1]))db.set(a[1],a[2]);return 'OK';}return db.get(a[1]);};
  const first=pilotEvidence(command,'https://flurbo.singu.online');
  const input={eventId:'a',outcome:2,statement:'Public fixture evidence, never a real market outcome.',sourceURL:'https://github.com/ethereum/go-ethereum/releases',attachment:'fixture'};
  const saved=await first.put(input,owner,rules),second=pilotEvidence(command,'https://flurbo.singu.online');
  assert.equal(await second.get(saved.hash),saved.body);
  assert.equal((await first.put(input,owner,rules)).hash,saved.hash);
  await assert.rejects(first.put({...input,sourceURL:'file:///private'},owner,rules));
  db.set([...db.keys()][0],'corrupt');await assert.rejects(second.get(saved.hash));
});

test('pilot RPC accepts only public testnet read endpoints and validates response identity',async()=>{
  assert.throws(()=>pilotRpc('http://localhost:8545'));
  const rpc=pilotRpc('https://testnet-rpc.monad.xyz',async(_url:any,init:any)=>{const input=JSON.parse(init.body);return Response.json({jsonrpc:'2.0',id:input.id,result:'0x279f'});});
  assert.equal(await rpc('eth_chainId',[]),'0x279f');await assert.rejects(rpc('eth_sendRawTransaction',['0x00']));
  await assert.rejects(pilotRpc('https://testnet-rpc.monad.xyz',async()=>Response.json({jsonrpc:'2.0',id:99,result:'0x279f'}))('eth_chainId',[]));
});

test('pilot review validates caller intent and saves tracking before sending, including numeric wallet nonces',async(t)=>{
  const f=pilotFixture(); f.options.allowance=1_000_000n;
  const review=await f.service.prepare({owner,action:'buy',scope:3,mask:'8',quantity:'1000000',slippageBps:50});
  t.mock.method(globalThis,'fetch',async()=>Response.json(review.semanticAssessment));
  let saved:any=null,sends=0;
  const provider={request:async({method,params=[]}:any)=>{
    if(method==='eth_accounts')return [owner];
    if(method==='eth_getBalance')return '0xde0b6b3a7640000';
    if(method==='eth_getTransactionCount')return 121;
    if(method==='eth_sendTransaction'){assert.equal(saved.hash,null);assert.equal(params[0].nonce,'0x79');sends++;return hash;}
    return f.rpc(method,params);
  }};
  await submitPilot(provider,review,owner,value=>{saved=value;},()=>true);
  assert.equal(sends,1);assert.equal(saved.hash,hash);
  await assert.rejects(submitPilot(provider,review,owner,()=>{throw new Error('storage unavailable');},()=>true));assert.equal(sends,1);
  assert.throws(()=>validatePilotReview({...review,requested:{...review.requested,quantity:'2000000'}}));
  assert.throws(()=>validatePilotReview(review,(review.expiresAt+1)*1000));
  assert.throws(()=>rpcInteger(Number.MAX_SAFE_INTEGER+1));
});

test('account read avoids resolver case scans but still verifies deployment and snapshot',async()=>{
  const f=pilotFixture();let reads=0;
  const service=pilotService({manifest:f.manifest,rpc:async(method:string,params:any[])=>{
    reads++;if(method==='eth_call'){
      const {functionName}=decodeFunctionData({abi:[...resolverAbi,...pilotPoolAbi,...pilotCashAbi],data:params[0].data});
      assert.ok(['pool','settlementRulesHash','balanceOf','factors'].includes(functionName));
    }
    return f.rpc(method,params);
  }});
  const result=await service.account(owner);assert.equal(result.wallet.cash,'100000000');assert.equal(result.wallet.address,owner);assert.equal(reads,10);
  await assert.rejects(service.account('invalid'));
  f.options.changed=true;await assert.rejects(service.account(owner));
});

test('log range errors are classified without exposing upstream details; transport failures are not range errors',async()=>{
  const rejected=(message:string,status=200)=>pilotRpc('https://monad-testnet.g.alchemy.com/v2/test-key',async(_url:any,init:any)=>Response.json({jsonrpc:'2.0',id:JSON.parse(init.body).id,error:{code:-32602,message}},{status}));
  await assert.rejects(rejected('eth_getLogs block range limit: secret-key')('eth_getLogs',[]),(e:any)=>e.code==='LOG_RANGE_LIMIT'&&!e.message.includes('secret-key'));
  await assert.rejects(rejected('eth_getLogs block range limit: secret-key',400)('eth_getLogs',[]),(e:any)=>e.code==='LOG_RANGE_LIMIT'&&!e.message.includes('secret-key'));
  await assert.rejects(rejected('rate limit reached')('eth_getLogs',[]),(e:any)=>e.code===undefined);
  await assert.rejects(rejected('block range limit')('eth_call',[]),(e:any)=>e.code===undefined);
  await assert.rejects(rejected('block range limit',429)('eth_getLogs',[]),(e:any)=>e.code===undefined);
});

test('a combination the pool cannot price is refused before quoting, with a reason, and the ticket can see why', async () => {
  const { combinationFits, COMBINATION_LIMIT_MESSAGE } = await import('../shared/pilot.mjs');
  // pre-test-v1 on 30 September 2026: NBP was linked to Monad and USGS, so NBP + EMSC could not be priced.
  const traded = [2, 1, 3, 5, 7], order = [0, 1, 2, 3];
  assert.equal(combinationFits(4, order, traded, 9), false);
  assert.equal(combinationFits(4, order, traded, 12), true, 'USGS + EMSC does not add a fourth link to NBP');
  assert.equal(combinationFits(4, order, traded, 5), true, 'a combination already in the pool always fits');
  assert.equal(combinationFits(4, order, [], 9), true);
  const f = pilotFixture(undefined, 4);
  f.options.factors = traded.map(scope => ({ scope, values: [0n] }));
  const status = await f.service.status(owner);
  assert.deepEqual(status.factorScopes, traded); assert.deepEqual(status.eliminationOrder, order);
  await assert.rejects(f.service.prepare({ owner, action: 'buy', scope: 9, mask: '8', quantity: '1000000', slippageBps: 50 }),
    (error: any) => error.status === 409 && error.message === COMBINATION_LIMIT_MESSAGE);
  await f.service.prepare({ owner, action: 'buy', scope: 12, mask: '8', quantity: '1000000', slippageBps: 50 });
  // Selling a combination already held is never limited.
  await f.service.prepare({ owner, action: 'sell', scope: 5, mask: '8', quantity: '1000000', slippageBps: 50 });
});

test('a QuickNode Monad testnet endpoint is accepted everywhere the server reads the chain, and its token never leaks', async () => {
  const { testnetRpcHost, hostedConfig } = await import('../server/network.mjs');
  const { agentRpc } = await import('../server/agents/agent-market.mjs');
  const { learningRpc } = await import('../server/learning-pool.mjs');
  const quicknode = 'https://little-dawn-cloud.monad-testnet.quiknode.pro/secret-token-123/';
  for (const host of ['testnet-rpc.monad.xyz', 'monad-testnet.g.alchemy.com', 'little-dawn-cloud.monad-testnet.quiknode.pro']) assert.equal(testnetRpcHost(host), true, host);
  for (const host of ['x.monad-mainnet.quiknode.pro', 'a.b.monad-testnet.quiknode.pro', 'monad-testnet.quiknode.pro.evil.com', 'evil.com']) assert.equal(testnetRpcHost(host), false, host);
  assert.throws(() => pilotRpc('https://x.monad-mainnet.quiknode.pro/token/'), /testnet RPC required/);
  agentRpc(quicknode); learningRpc(quicknode);
  assert.equal(hostedConfig({ FLURBO_ORIGIN: 'https://flurbo.singu.online', FLURBO_NETWORK: 'public_testnet', FLURBO_ALCHEMY_TESTNET_RPC_URL: quicknode }).rpcUrl, quicknode);
  const rpc = pilotRpc(quicknode, async () => new Response('upstream said secret-token-123', { status: 500 }));
  await assert.rejects(rpc('eth_chainId', []), (e: Error) => !String(e.message).includes('secret-token-123'));
});
