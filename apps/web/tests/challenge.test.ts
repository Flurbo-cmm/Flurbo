import assert from 'node:assert/strict';
import {test} from 'node:test';
import {decodeFunctionData,encodeFunctionResult} from 'viem';
import {pilotFixture,owner,resolver,hash} from './pilot-fixture.ts';
import {pilotService} from '../server/pilot.mjs';
import {resolverAbi} from '../shared/pilot.mjs';
import {challengeUnavailable} from '../src/challenge.ts';

export function challengeFixture(){
  const now=Math.floor(Date.now()/1000),f=pilotFixture(now,4);
  f.manifest.publication.mode='rehearsal';
  const c={phase:1,proposal:2,counter:0,result:0,asserter:'0x'+'aa'.repeat(20),disputer:'0x'+'00'.repeat(20),evidenceHash:hash,counterEvidenceHash:'0x'+'00'.repeat(32),challengeUntil:BigInt(now+3600),voteUntil:0n,votes:[0,0,0]};
  let reviewer=false;
  const rpc=async(method:string,params:any[]=[])=>{
    if(method==='eth_call'&&params[0].to===resolver&&!params[0].from){
      const {functionName}=decodeFunctionData({abi:resolverAbi,data:params[0].data});
      if(functionName==='caseState')return encodeFunctionResult({abi:resolverAbi,functionName,result:c});
      if(functionName==='isReviewer')return encodeFunctionResult({abi:resolverAbi,functionName,result:reviewer});
    }
    return f.rpc(method,params);
  };
  return {...f,c,now,rpc,setReviewer:(v:boolean)=>{reviewer=v;},service:pilotService({manifest:f.manifest,rpc,now:()=>now})};
}

test('public challenge prepares only an eligible alternative before the chain deadline, including approval and withdrawal',async()=>{
  const f=challengeFixture(),input={owner,action:'dispute',event:0,outcome:1,evidenceHash:hash,evidenceURI:'https://flurbo.singu.online/api/pilot/evidence/'+hash};
  const approval=await f.service.prepare(input);assert.equal(approval.action,'approve');assert.equal(approval.amountAtoms,'1000000');
  f.options.allowance=1_000_000n;assert.equal((await f.service.prepare(input)).action,'dispute');
  await assert.rejects(f.service.prepare({...input,outcome:2}),/Challenge is not available/);
  await assert.rejects(f.service.prepare({...input,owner:f.c.asserter}),/Challenge is not available/);
  f.setReviewer(true);await assert.rejects(f.service.prepare(input),/Challenge is not available/);f.setReviewer(false);
  f.c.challengeUntil=BigInt(f.now);await assert.rejects(f.service.prepare(input),/Challenge is not available/);
  f.c.challengeUntil=BigInt(f.now+100);f.c.phase=2;await assert.rejects(f.service.prepare(input),/Challenge is not available/);
  f.c.phase=3;await assert.rejects(f.service.prepare(input),/Challenge is not available/);
  assert.equal((await f.service.prepare({owner,action:'withdrawBond'})).action,'withdrawBond');
});

test('challenge display distinguishes waiting, disputes, final results, expiry and ineligible wallets',async()=>{
  const f=challengeFixture(),s=await f.service.status(owner);
  assert.equal(challengeUnavailable(s,0,owner,f.now),'');
  assert.match(challengeUnavailable(s,0,f.c.asserter,f.now),/proposed/);
  assert.match(challengeUnavailable(s,0,f.manifest.publication.reviewers[0].address,f.now),/Reviewer/);
  assert.match(challengeUnavailable(s,0,owner,Number(f.c.challengeUntil)),/ended/);
  for(const [phase,match] of [[0,/No answer/],[2,/challenged/],[3,/final/]] as const){s.cases[0].phase=phase;assert.match(challengeUnavailable(s,0,owner,f.now),match);}
});
