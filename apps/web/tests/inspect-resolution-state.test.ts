import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {inspectResolutionState,readOnly} from '../scripts/inspect-resolution-state.mjs';
import {monitorIdentity} from '../server/settlement-monitor.mjs';
import {pilotFixture} from './pilot-fixture.ts';

const signer='0x'+'63'.repeat(20),now=1800000000;
const key=(id:string)=>'flurbo:monitor:v1:'+createHash('sha256').update(id).digest('hex');

test('inspection is strictly read-only and never prints signed transaction bytes',async()=>{
  const m=pilotFixture(now).manifest,data=new Map<string,string>(),ops:string[]=[];
  const raw='0xf86b'+'ab'.repeat(100);
  data.set(key('resolution-worker-v1:'+signer)+':state',JSON.stringify({schema:'flurbo.resolution-journals.v2',pools:{[m.pool]:{
    schema:'flurbo.resolution-worker.v1',pool:m.pool,rulesHash:m.rulesHash,owned:{0:{outcome:2,evidenceHash:'0x01'}},deferred:{1:now+600},
    pending:{hash:'0x'+'cd'.repeat(32),raw,action:'finalize',event:2},last:{hash:'0x'+'ef'.repeat(32),success:true,at:now-60}}}}));
  data.set(key(monitorIdentity(m))+':state',JSON.stringify({checkpoint:{identity:monitorIdentity(m),checkedAt:now-120},report:{status:'observed'},queue:[]}));
  const command=async(op:string,k:string)=>{ops.push(op);if(op==='GET')return data.get(k)??null;if(op==='PTTL')return k.endsWith(':lock')?-2:-2;throw Error('unexpected');};
  const rpc=async(method:string)=>{assert.equal(method,'eth_getTransactionReceipt');return null;};
  const r=await inspectResolutionState({command,rpc,manifests:[m],signer,now});
  assert.equal(r.anyPending,true);
  assert.deepEqual(r.journal.pools[0].pending,{hash:'0x'+'cd'.repeat(32),action:'finalize',event:2,outcome:null,chain:{included:false}});
  assert.deepEqual(r.journal.pools[0].ownedEvents,[0]);assert.deepEqual(r.signerLease,{held:false});
  assert.deepEqual(r.monitors[0],{pool:m.pool,status:'observed',checkedAt:new Date((now-120)*1000).toISOString(),ageSeconds:120,queued:0,identityMatches:true});
  assert.ok(!JSON.stringify(r).includes('ab'.repeat(20)),'raw signed bytes are never printed');
  assert.ok(ops.every(op=>['GET','PTTL'].includes(op)));
  await assert.rejects(async()=>readOnly(command)('SET','x','y'),/read-only/);
  await assert.rejects(async()=>readOnly(command)('DEL','x'),/read-only/);
  await assert.rejects(async()=>readOnly(command)('EVAL','x'),/read-only/);
  const empty=await inspectResolutionState({command:async(op:string)=>op==='PTTL'?-2:null,rpc,manifests:[m],signer,now});
  assert.equal(empty.journal,null);assert.equal(empty.anyPending,false);assert.equal(empty.monitors[0].status,null);
});
