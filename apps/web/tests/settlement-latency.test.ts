import {test} from 'node:test';
import assert from 'node:assert/strict';
import {decodeFunctionData,encodeFunctionResult} from 'viem';
import {resolverAbi} from '../shared/pilot.mjs';
import {measureSettlement,percentile} from '../server/settlement-latency.mjs';

const T0=1_000_000,HEAD=20_000,bot='0x'+'63'.repeat(20),other='0x'+'77'.repeat(20),zero='0x'+'00'.repeat(20);
const obs=T0+1000,deadline=obs+3600,challenge=3600,voting=3600;
const at=(ts:number)=>ts-T0; // block number whose timestamp is ts
// Four events, one per path. Timestamps are when each transition's transaction was included.
const e0={assertedAt:obs+50,finalizedAt:obs+50+challenge+120};              // bot, uncontested
const e1={finalizedAt:deadline+300};                                          // no assertion: timeout
const e2={assertedAt:obs+10,disputedAt:obs+900,finalizedAt:obs+900+voting+60}; // disputed, vote timeout
const e3={assertedAt:obs+20,disputedAt:obs+800,finalizedAt:obs+1500};          // disputed, quorum (human)
const deliveredAt=Math.max(e0.finalizedAt,e1.finalizedAt,e2.finalizedAt,e3.finalizedAt)+30;
const blank={phase:0,proposal:0,counter:0,result:0,asserter:zero,disputer:zero,evidenceHash:'0x'+'00'.repeat(32),counterEvidenceHash:'0x'+'00'.repeat(32),challengeUntil:0n,voteUntil:0n,votes:[0,0,0]};
function caseAt(event:number,ts:number){
  if(event===0){if(ts<e0.assertedAt)return blank;return {...blank,phase:ts>=e0.finalizedAt?3:1,proposal:2,result:ts>=e0.finalizedAt?2:0,asserter:bot,challengeUntil:BigInt(e0.assertedAt+challenge)};}
  if(event===1)return ts>=e1.finalizedAt?{...blank,phase:3,result:3}:blank;
  if(event===2){if(ts<e2.assertedAt)return blank;const d=ts>=e2.disputedAt,f=ts>=e2.finalizedAt;
    return {...blank,phase:f?3:d?2:1,proposal:2,counter:d?1:0,result:f?3:0,asserter:other,disputer:d?bot:zero,challengeUntil:BigInt(e2.assertedAt+challenge),voteUntil:d?BigInt(e2.disputedAt+voting):0n,votes:[0,0,f?0:0]};}
  if(ts<e3.assertedAt)return blank;const d=ts>=e3.disputedAt,f=ts>=e3.finalizedAt;
  return {...blank,phase:f?3:d?2:1,proposal:2,counter:1,result:f?1:0,asserter:bot,disputer:d?other:zero,challengeUntil:BigInt(e3.assertedAt+challenge),voteUntil:d?BigInt(e3.disputedAt+voting):0n,votes:f?[2,0,0]:[0,0,0]};
}
function rpc(){
  let calls=0;
  const fn=async(method:string,params:any[])=>{
    calls++;
    if(method==='eth_getBlockByNumber'){const n=params[0]==='latest'?HEAD:Number(BigInt(params[0]));return {number:'0x'+n.toString(16),timestamp:'0x'+(T0+n).toString(16)};}
    const n=params[1]==='latest'?HEAD:Number(BigInt(params[1])),ts=T0+n;
    const {functionName,args}=decodeFunctionData({abi:resolverAbi,data:params[0].data}) as any;
    const result=functionName==='challengePeriod'?challenge:functionName==='votingPeriod'?voting:functionName==='delivered'?ts>=deliveredAt
      :functionName==='assertionDeadline'?BigInt(deadline):caseAt(Number(args[0]),ts);
    return encodeFunctionResult({abi:resolverAbi,functionName,result} as any);
  };
  return {fn,count:()=>calls};
}

test('percentiles use nearest rank and handle empty input',()=>{
  assert.equal(percentile([],50),null);assert.equal(percentile([5],99),5);
  assert.equal(percentile([1,2,3,4,5,6,7,8,9,10],50),5);assert.equal(percentile([1,2,3,4,5,6,7,8,9,10],99),10);
});

test('latency is measured from the action becoming due to its inclusion block, per settlement path',async()=>{
  const chain=rpc();
  const manifest={pool:'0x'+'22'.repeat(20),resolver:'0x'+'33'.repeat(20),publication:{draft:{events:[0,1,2,3].map(()=>({observationEndsAt:obs}))}}};
  const r=await measureSettlement({manifest,rpc:chain.fn,signer:bot});
  const find=(action:string,event:number|null)=>r.actions.find((a:any)=>a.action===action&&a.event===event);
  assert.deepEqual([find('assert',0).latencySeconds,find('assert',0).actor],[50,'bot']);
  assert.equal(find('assert',2).actor,'other');
  assert.deepEqual([find('finalize',0).path,find('finalize',0).latencySeconds,find('finalize',0).block],['uncontested',120,at(e0.finalizedAt)]);
  assert.deepEqual([find('finalize',1).path,find('finalize',1).latencySeconds],['assertion-timeout',300]);
  assert.deepEqual([find('finalize',2).path,find('finalize',2).latencySeconds],['vote-timeout',60]);
  assert.equal(find('finalize',3),undefined,'quorum finalization is a human action and is not an automation latency');
  assert.deepEqual([find('deliver',null).latencySeconds,find('deliver',null).block],[30,at(deliveredAt)]);
  assert.deepEqual(r.summary.finalize,{count:3,p50:120,p99:300,max:300});
  assert.ok(chain.count()<400,'binary searches keep the read count bounded');
});
