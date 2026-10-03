import assert from 'node:assert/strict';
import {test} from 'node:test';
import {agentStore,memoryBackend,accountDigest} from '../server/agents/agent-store.mjs';
import {agentPortfolio} from '../server/agents/portfolio.mjs';

const alice='0x'+'11'.repeat(20),bob='0x'+'22'.repeat(20),wallet='0x'+'33'.repeat(20),pool='0x'+'44'.repeat(20);
const hash='0x'+'55'.repeat(32),origin='https://flurbo.singu.online';
test('portfolio includes verified agent trades, separates accounts and retains archive history without claiming a reassigned wallet',async()=>{
 const store=agentStore(memoryBackend()),links={ownerOf:async()=>null};
 const profile=await store.create(alice,{kind:'runtime',name:'Rust October E2E',status:'active',wallet:null,walletHistory:[]});
 await store.associateWallet(alice,profile.id,wallet,100);
 const read=(account:string)=>agentPortfolio({store,links,account,origin,serviceFor:()=>({manifest:{pool}})});
 await store.mutate(alice,profile.id,(state:any)=>{
  const record={hash,namespace:'pilot',status:'confirmed',intent:{action:'buy',claim:{scope:3,mask:'8'},quantityAtoms:'1000000'},verification:{from:wallet,blockNumber:'200',blockTimestamp:110,collateralAtoms:'300000'}};
  state.runtime.executions=[record,{...record,hash:'0x'+'66'.repeat(32),status:'pending'},{...record,hash:'0x'+'77'.repeat(32),status:'attributed-elsewhere'},{...record,hash:'0x'+'88'.repeat(32),intent:{action:'approve',claim:null}}];
  return true;
 });
 let result=await read(alice);assert.deepEqual(result.wallets,[wallet]);assert.equal(result.executions.length,1);assert.equal(result.executions[0].agentName,'Rust October E2E');assert.equal(result.executions[0].cash,'300000');
 assert.deepEqual(await read(bob),{wallets:[],executions:[]});
 await store.archive(alice,profile.id,120);
 result=await read(alice);assert.deepEqual(result.wallets,[wallet]);assert.equal(result.executions.length,1);
 const foreign=await store.create(bob,{kind:'runtime',name:'Other account',status:'active',wallet:null,walletHistory:[]});
 await store.associateWallet(bob,foreign.id,wallet,130);
 assert.equal((await store.agentWallet(wallet)).owner,accountDigest(bob));
 result=await read(alice);assert.deepEqual(result.wallets,[]);assert.equal(result.executions[0].hash,hash,'only Alice historical trade remains');
 assert.deepEqual((await read(bob)).wallets,[wallet]);assert.deepEqual((await read(bob)).executions,[],'no Alice metadata leaks');
});

test('replaced wallet remains readable unless another account links it manually; duplicate associations do not duplicate balances',async()=>{
 const store=agentStore(memoryBackend());let manual:string|null=null;
 const links={ownerOf:async(address:string)=>address===wallet?manual:null};
 const profile=await store.create(alice,{kind:'runtime',name:'First',status:'active',wallet:null,walletHistory:[]});
 await store.associateWallet(alice,profile.id,wallet,100);
 await store.associateWallet(alice,profile.id,'0x'+'99'.repeat(20),110);
 const read=()=>agentPortfolio({store,links,account:alice,origin,serviceFor:()=>null});
 assert.equal((await read()).wallets.length,2);
 manual=bob;assert.deepEqual((await read()).wallets,['0x'+'99'.repeat(20)]);
 manual=alice;
 const second=await store.create(alice,{kind:'runtime',name:'Second',status:'active',wallet:null,walletHistory:[]});
 await store.associateWallet(alice,second.id,wallet,120);
 assert.equal((await read()).wallets.length,2);
});
