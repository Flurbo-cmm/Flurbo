import {test} from 'node:test';
import assert from 'node:assert/strict';
import {activityEvent,ACTIVITY_METRICS,activityOutcome,validateActivityDraft} from '../shared/ethereum-activity.mjs';
import {activityBlock,observeEthereumActivity,ethereumRpc,activityEvidence} from '../server/ethereum-activity.mjs';
const target=1800000000,now=target+2000;
const draft={title:'Showcase v0',clusterId:`showcase-v0-${target-120}`,closesAt:target-120,events:ACTIVITY_METRICS.map(m=>activityEvent(m,target))};
const hex=(n:number)=>'0x'+n.toString(16),hash=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
function block(n:number){return {number:hex(n),hash:hash(n),parentHash:hash(Math.max(0,n-1)),timestamp:hex(target+(n-100)*12),gasUsed:hex(750),gasLimit:hex(1000),baseFeePerGas:hex(n===100?101:100),blobGasUsed:hex(393216),transactions:Array(150).fill(hash(99))};}
function rpc(change:(b:any,tag:string)=>any=(b)=>b){return async(method:string,params:any[])=>method==='eth_chainId'?'0x1':change(block(params[0]==='finalized'?200:Number(BigInt(params[0]))),params[0]);}
test('one agreed finalized block selects all four metrics; exact thresholds and equal fees are explicit',async()=>{
  const r=await observeEthereumActivity(draft,{rpcs:[rpc(),rpc()],now});
  assert.equal(r.block.number,'100');assert.equal(r.parent.number,'99');assert.deepEqual(r.outcomes,[2,2,2,2]);
  const b=activityBlock(block(100)),p=activityBlock(block(99));
  assert.equal(activityOutcome('fees',{...b,baseFeePerGas:p.baseFeePerGas},p),1);
  assert.deepEqual(ACTIVITY_METRICS.map(m=>activityOutcome(m,{...b,gasUsed:749n,transactions:149,baseFeePerGas:99n,blobGasUsed:262144n},p)),[1,1,1,1]);
});
test('missing, conflicting, unfinalized and wrong-chain observations never become a NO',async()=>{
  for(const bad of [rpc(b=>({...b,blobGasUsed:undefined})),rpc(b=>({...b,gasUsed:hex(749)})),rpc((b,t)=>t==='finalized'?block(90):b),async()=> '0x279f',rpc(b=>({...b,parentHash:hash(1)}))]){
    await assert.rejects(observeEthereumActivity(draft,{rpcs:[rpc(),bad],now}));
  }
  await assert.rejects(observeEthereumActivity(draft,{rpcs:[rpc(),rpc()],now:target+1799}),/still open/);
  await assert.rejects(observeEthereumActivity(draft,{rpcs:[rpc()],now}),/Two/);
  const changed=structuredClone(draft);changed.events[0].yesRule+=' altered';assert.throws(()=>validateActivityDraft(changed));
  assert.throws(()=>activityBlock({...block(100),gasUsed:hex(1001)}));
});
test('Test uses two independently evaluated real metrics and rejects a changed recipe',async()=>{
  const testDraft={...draft,title:'Test',clusterId:`ethereum-test-v1-${draft.closesAt}`,events:draft.events.slice(0,2)};
  const changed=rpc(b=>({...b,gasUsed:hex(749)}));
  const report=await observeEthereumActivity(testDraft,{rpcs:[changed,changed],now});
  assert.deepEqual(report.outcomes,[1,2]);
  assert.throws(()=>validateActivityDraft({...testDraft,events:[...testDraft.events].reverse()}));
  assert.throws(()=>validateActivityDraft({...testDraft,events:draft.events}));
  assert.throws(()=>validateActivityDraft({...draft,events:draft.events.slice(0,2)}));
  const db=new Map();
  const command=async(op:string,key:string,value?:string)=>{if(op==='GET')return db.get(key)||null;if(!db.has(key))db.set(key,value);return 'OK';};
  const m={pool:'0x'+'bc'.repeat(20),rulesHash:hash(30),draftHash:hash(31),publication:{draft:testDraft}};
  const ev=await activityEvidence(m,command,{put:async()=>({hash:hash(32),uri:'https://example.test/evidence'})},'owner',async()=>report);
  assert.equal((await ev(0)).outcome,1);assert.equal((await ev(1)).outcome,2);
  await assert.rejects(ev(2),/Invalid event/);
});
test('Ethereum transport allows only fixed read-only sources and matching bounded JSON RPC responses',async()=>{
  assert.throws(()=>ethereumRpc('https://example.com'));
  const read=ethereumRpc('https://eth.drpc.org',async(_url:any,options:any)=>{const body=JSON.parse(options.body);return Response.json({jsonrpc:'2.0',id:body.id,result:'0x1'});});
  assert.equal(await read('eth_chainId',[]),'0x1');await assert.rejects(read('eth_sendRawTransaction',[]));
  await assert.rejects(ethereumRpc('https://eth.drpc.org',async()=>Response.json({jsonrpc:'2.0',id:99,result:'0x1'}))('eth_chainId',[]));
});
test('all event assertions reuse immutable archived evidence; corruption is rejected',async()=>{
  const db=new Map<string,string>();let reads=0;const records:any[]=[];
  const command=async(op:string,key:string,value?:string)=>{if(op==='GET')return db.get(key)||null;if(!db.has(key))db.set(key,value!);return 'OK';};
  const manifest={pool:'0x'+'ab'.repeat(20),rulesHash:hash(9),draftHash:hash(10),publication:{draft}};
  const archive={put:async(value:any)=>{records.push(value);return {hash:hash(11),uri:'https://flurbo.singu.online/evidence'};}};
  const observe=async()=>{reads++;return observeEthereumActivity(draft,{rpcs:[rpc(),rpc()],now});};
  assert.equal((await (await activityEvidence(manifest,command,archive,'owner',observe))(0)).outcome,2);
  await (await activityEvidence(manifest,command,archive,'owner',observe))(3);assert.equal(reads,1);
  assert.equal(JSON.parse(records[0].attachment).report.digest,JSON.parse(records[1].attachment).report.digest);
  const key=[...db.keys()][0],saved=JSON.parse(db.get(key)!);saved.outcomes[0]=1;db.set(key,JSON.stringify(saved));
  await assert.rejects(activityEvidence(manifest,command,archive,'owner',observe),/mismatch/);
});
