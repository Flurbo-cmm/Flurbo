import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters } from 'viem';
import { pilotIndex } from '../server/pilot-index.mjs';
import { resolverAbi } from '../shared/pilot.mjs';

test('persistent pilot index resumes, rejects concurrent updates and rebuilds after a reorg',async()=>{
  const hash=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
  const manifest={pool:'0x'+'11'.repeat(20),resolver:'0x'+'22'.repeat(20),verifiedBlock:'100',verifiedBlockHash:hash(100)};
  let stored:string|null=null,reorg=false,conflict=false;
  const command=async(...a:any[])=>{if(a[0]==='GET')return stored;if(conflict||a[4] !==(stored||''))return 0;stored=a[5];return 1;};
  const rpc=async(method:string,params:any[])=>{
    if(method==='eth_getBlockByNumber'){
      const n=params[0]==='latest'?110:Number(BigInt(params[0]));return{number:'0x'+n.toString(16),hash:hash(n+(reorg&&n>100?1000:0))};
    }
    if(method==='eth_getLogs')return reorg?[]:[{address:manifest.resolver,blockNumber:'0x65',blockHash:hash(101),transactionHash:hash(1001),logIndex:'0x0',removed:false,
      topics:encodeEventTopics({abi:resolverAbi,eventName:'Finalized',args:{eventIndex:0}}),data:encodeAbiParameters(parseAbiParameters('uint8,bool'),[2,false])}];
    throw new Error(method);
  };
  const first=await pilotIndex({manifest,rpc,command}).refresh();assert.equal(first.logs.length,1);assert.equal(first.through,108);assert.equal(first.complete,true);
  const resumed=await pilotIndex({manifest,rpc,command}).refresh();assert.equal(resumed.logs.length,1);
  reorg=true;const rebuilt=await pilotIndex({manifest,rpc,command}).refresh();assert.equal(rebuilt.logs.length,0);assert.equal(rebuilt.hash,hash(1108));
  stored=null;conflict=true;await assert.rejects(pilotIndex({manifest,rpc,command}).refresh());assert.equal(stored,null);
});

test('simultaneous readers share one scan and a failed scan can be retried',async()=>{
  const hash='0x'+'11'.repeat(32);
  let attempts=0,fail=true;
  const index=pilotIndex({manifest:{pool:'0x'+'22'.repeat(20),resolver:'0x'+'33'.repeat(20),verifiedBlock:'100',verifiedBlockHash:hash},
    command:async()=>{attempts++;await new Promise(resolve=>setTimeout(resolve,5));if(fail)throw new Error('Redis unavailable');return null;},
    rpc:async()=>({number:'0x66',hash})});
  const first=index.refresh(),second=index.refresh();assert.equal(first,second);
  const rejected=await Promise.allSettled([first,second]);assert.ok(rejected.every(r=>r.status==='rejected'));assert.equal(attempts,1);
  fail=false;assert.equal((await index.refresh()).complete,true);assert.equal(attempts,2);
});

test('restricted log ranges make bounded contiguous progress, resume and retain trades',async()=>{
  const hash=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
  const manifest={pool:'0x'+'11'.repeat(20),resolver:'0x'+'22'.repeat(20),verifiedBlock:'100',verifiedBlockHash:hash(100)};
  let stored:string|null=null,calls=0,last=100;
  const command=async(...a:any[])=>{if(a[0]==='GET')return stored;assert.equal(a[4],stored||'');stored=a[5];return 1;};
  const rpc=async(method:string,params:any[])=>{
    if(method==='eth_getBlockByNumber'){
      const n=params[0]==='latest'?352:Number(BigInt(params[0]));return {number:'0x'+n.toString(16),hash:hash(n)};
    }
    calls++;const from=Number(BigInt(params[0].fromBlock)),to=Number(BigInt(params[0].toBlock));
    if(to-from+1>10)throw Object.assign(new Error('range rejected'),{code:'LOG_RANGE_LIMIT'});
    assert.equal(from,last+1);last=to;
    return from<=225&&to>=225?[{address:manifest.resolver,blockNumber:'0xe1',blockHash:hash(225),transactionHash:hash(999),logIndex:'0x0',removed:false,
      topics:encodeEventTopics({abi:resolverAbi,eventName:'Finalized',args:{eventIndex:0}}),data:encodeAbiParameters(parseAbiParameters('uint8,bool'),[2,false])}]:[];
  };
  const index=pilotIndex({manifest,rpc,command,now:()=>0});
  const first=await index.refresh();assert.equal(first.complete,false);assert.equal(first.through,210);assert.equal(calls,12);
  const second=await index.refresh();assert.equal(second.through,330);assert.equal(second.logs.length,1);assert.equal(calls,24);
  const third=await index.refresh();assert.equal(third.complete,true);assert.equal(third.through,350);assert.equal(third.logs.length,1);
});

test('slow reads checkpoint completed windows; rejected reads and reorgs never advance storage',async()=>{
  const hash=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
  const manifest={pool:'0x'+'11'.repeat(20),resolver:'0x'+'22'.repeat(20),verifiedBlock:'100',verifiedBlockHash:hash(100)};
  let stored:string|null=null,time=0,mode='slow',scanned=false;
  const command=async(...a:any[])=>{if(a[0]==='GET')return stored;stored=a[5];return 1;};
  const rpc=async(method:string,params:any[])=>{
    if(method==='eth_getBlockByNumber'){
      const n=params[0]==='latest'?1102:Number(BigInt(params[0]));return {number:'0x'+n.toString(16),hash:hash(n+(mode==='reorg'&&scanned&&n>100?10000:0))};
    }
    if(mode==='failure')throw new Error('transport unavailable');
    scanned=true;time+=9000;return [];
  };
  const first=await pilotIndex({manifest,rpc,command,now:()=>time}).refresh();assert.equal(first.through,200);assert.equal(first.complete,false);
  const saved=stored;mode='failure';await assert.rejects(pilotIndex({manifest,rpc,command}).refresh());assert.equal(stored,saved);
  stored=null;mode='reorg';scanned=false;await assert.rejects(pilotIndex({manifest,rpc,command,now:()=>time}).refresh(),/changed/);assert.equal(stored,null);
});

test('catch-up finishes a fixed persisted target even as new blocks arrive; refresh then starts a new snapshot',async()=>{
  const hash=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
  const manifest={pool:'0x'+'11'.repeat(20),resolver:'0x'+'22'.repeat(20),verifiedBlock:'100',verifiedBlockHash:hash(100)};
  let stored:string|null=null,head=1252;
  const command=async(...a:any[])=>{if(a[0]==='GET')return stored;assert.equal(a[4],stored||'');stored=a[5];return 1;};
  const rpc=async(method:string,params:any[])=>{
    if(method==='eth_getLogs')return [];
    const n=params[0]==='latest'?head:Number(BigInt(params[0]));return {number:'0x'+n.toString(16),hash:hash(n)};
  };
  const index=()=>pilotIndex({manifest,rpc,command,now:()=>0});
  const first=await index().refresh();assert.equal(first.through,1100);assert.equal(first.target,1250);assert.equal(first.complete,false);
  head=2252;
  // Reconstruction simulates a server restart or another instance reading Redis.
  const second=await index().refresh();assert.equal(second.through,1250);assert.equal(second.target,1250);assert.equal(second.complete,true);
  const fresh=await index().refresh();assert.equal(fresh.target,2250);assert.equal(fresh.through,2250);assert.equal(fresh.complete,true);
});
