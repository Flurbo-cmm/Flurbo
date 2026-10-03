import assert from 'node:assert/strict';
import {test} from 'node:test';
import {decodeFunctionData,encodeFunctionResult} from 'viem';
import {pilotFixture,owner,pool} from './pilot-fixture.ts';
import {pilotService} from '../server/pilot.mjs';
import {pilotPoolAbi} from '../shared/pilot.mjs';
test('holdings reads are bounded concurrent, ordered and snapshot checked; zero quantities need no payout call',async()=>{
  const f=pilotFixture();let active=0,max=0,fractions=0;
  const rpc=async(method:string,params:any[])=>{
    if(method==='eth_call'&&params[0].to===pool){const decoded=decodeFunctionData({abi:pilotPoolAbi,data:params[0].data});
      if(decoded.functionName==='resolved')return encodeFunctionResult({abi:pilotPoolAbi,functionName:'resolved',result:true});
      if(decoded.functionName==='holdings'){active++;max=Math.max(active,max);await new Promise(r=>setTimeout(r,5));active--;return encodeFunctionResult({abi:pilotPoolAbi,functionName:'holdings',result:decoded.args![2]===2n?3n:0n});}
      if(decoded.functionName==='payoutFraction'){fractions++;return encodeFunctionResult({abi:pilotPoolAbi,functionName:'payoutFraction',result:[1n,2n]});}
    }return f.rpc(method,params);
  };
  const service=pilotService({manifest:f.manifest,rpc});
  const claims=[{scope:1,mask:'2'},{scope:1,mask:'1'},{scope:2,mask:'2'},{scope:2,mask:'1'},{scope:3,mask:'8'}];
  const result=await service.positions(owner,claims);assert.equal(max,4);assert.equal(fractions,2);assert.deepEqual(result.rows.map((r:any)=>r.mask),claims.map(c=>c.mask));assert.deepEqual(result.rows.map((r:any)=>r.payoutAtoms),['1','0','1','0','0']);
  f.options.changed=true;await assert.rejects(service.positions(owner,claims),/anchor changed/);
});

test('multicall holdings use one batch and retain rounding per owning wallet',async()=>{
 const f=pilotFixture();let batches=0;
 const rpc:any=async(method:string,params:any[])=>{
  if(method==='eth_call'&&params[0].to===pool&&decodeFunctionData({abi:pilotPoolAbi,data:params[0].data}).functionName==='resolved')return encodeFunctionResult({abi:pilotPoolAbi,functionName:'resolved',result:true});
  return f.rpc(method,params);
 };
 rpc.readBatch=async(calls:any[],tag:string)=>{assert.equal(tag,'0x64');batches++;return calls.map(c=>c.fn==='holdings'?3n:[1n,2n]);};
 const result=await pilotService({manifest:f.manifest,rpc}).positions(owner,[{scope:1,mask:'2'},{scope:2,mask:'2'}]);
 assert.equal(batches,2);assert.deepEqual(result.rows.map((r:any)=>r.payoutAtoms),['1','1']);
 rpc.readBatch=async()=>{throw Error('Incomplete read batch');};await assert.rejects(pilotService({manifest:f.manifest,rpc}).positions(owner,[{scope:1,mask:'2'}]),/Incomplete/);
});
