import assert from 'node:assert/strict';
import {test} from 'node:test';
import {verifyTypedData,encodeFunctionData,decodeFunctionData,encodeFunctionResult} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {holderAuthorizer} from '../server/holder-challenge.mjs';
import {eligibilityTypedData,dependsOnEvent,challengeCandidates,holderResolverAbi} from '../shared/holder-challenge.mjs';
import {pilotCall} from '../shared/pilot.mjs';
import {pilotFixture,owner,hash,resolver} from './pilot-fixture.ts';
import {challengeFixture} from './challenge.test.ts';
import {pilotService} from '../server/pilot.mjs';
import {validatePilotReview} from '../src/pilot.ts';

test('event relevance includes all dependent Boolean masks and excludes scope padding',()=>{
  assert.equal(dependsOnEvent(1,2n,0,4),true);assert.equal(dependsOnEvent(1,1n,0,4),true);
  for(const mask of [8n,14n,6n])assert.equal(dependsOnEvent(3,mask,0,4),true);
  assert.equal(dependsOnEvent(3,12n,0,4),false);assert.equal(dependsOnEvent(2,2n,0,4),false);
  assert.equal(dependsOnEvent(16,2n,0,4),false);assert.equal(dependsOnEvent(15,8n,0,4),false);
  const claims=challengeCandidates([owner],0,4,[1,3,7]);
  assert.ok(claims.some(c=>c.scope===3&&c.mask==='6'));assert.ok(claims.some(c=>c.wrapped));
  assert.ok(claims.every(c=>dependsOnEvent(c.scope,BigInt(c.mask),0,4)));
});

test('holder resolver review encodes approval then a freshly authorized dispute, and validates the exact authorization',async()=>{
  const f=challengeFixture(),key=('0x'+'19'.repeat(32)) as `0x${string}`,authority=privateKeyToAccount(key);
  f.manifest.challengePolicy={version:'account-holders-v1',authority:authority.address.toLowerCase()};
  let owns=true;
  const rpc=async(method:string,params:any[]=[])=>{
    if(method==='eth_call'&&params[0].to===resolver){
      let name:string|undefined;try{name=decodeFunctionData({abi:holderResolverAbi,data:params[0].data}).functionName;}catch{}
      if(name==='eligibilitySigner')return encodeFunctionResult({abi:holderResolverAbi,functionName:name,result:authority.address});
      if(name==='hasQualifyingShares')return encodeFunctionResult({abi:holderResolverAbi,functionName:name,result:owns});
      if(name==='dispute'&&params[0].from)return '0x';
    }
    return f.rpc(method,params);
  };
  const service=pilotService({manifest:f.manifest,rpc,now:()=>f.now}),authorize=holderAuthorizer({env:{FLURBO_CHALLENGE_AUTHORIZATION_KEY:key},now:()=>f.now});
  const {stake,...input}={owner,action:'dispute',event:0,outcome:1,evidenceHash:hash,evidenceURI:'https://example.org/evidence',stake:{holder:owner,scope:1,mask:'2',wrapped:false}};
  const first=await authorize(service,{},[owner],{...input,stake}),approval=await service.prepare({...input,...first});
  assert.equal(validatePilotReview(approval).name,'approve');f.options.allowance=1000000n;
  const second=await authorize(service,{},[owner],{...input,stake}),dispute=await service.prepare({...input,...second});
  assert.notEqual(second.authorization.nonce,first.authorization.nonce);assert.equal(validatePilotReview(dispute).name,'dispute');
  const changed=structuredClone(dispute);changed.requested.authorization.holder='0x'+'ab'.repeat(20);
  assert.throws(()=>validatePilotReview(changed),/eligibility changed/);
  assert.throws(()=>validatePilotReview(dispute,(f.now+91)*1000),/eligibility expired/);
  assert.doesNotThrow(()=>validatePilotReview(dispute,(f.now+91)*1000,true));
  owns=false;assert.equal((await service.challengeStake(0,stake)).eligible,false);
  await assert.rejects(authorize(service,{},[owner],{...input,stake}),/No qualifying shares/);
});

test('server authorizes a distinct linked holder, binds intent and never trusts a supplied balance',async()=>{
  const key=('0x'+'19'.repeat(32)) as `0x${string}`,signer=privateKeyToAccount(key),other='0x'+'aa'.repeat(20);
  const now=Math.floor(Date.now()/1000),f=pilotFixture(now),policy={version:'account-holders-v1',authority:signer.address.toLowerCase()};
  f.manifest.challengePolicy=policy;
  let eligible=true;
  const service={manifest:f.manifest,challengeStake:async()=>({eligible,snapshot:{timestamp:now},challengeUntil:now+3600})};
  const authorize=holderAuthorizer({env:{FLURBO_CHALLENGE_AUTHORIZATION_KEY:key},now:()=>now});
  const input={owner,action:'dispute',event:0,outcome:1,evidenceHash:hash,evidenceURI:'https://example.org/evidence',stake:{holder:other,scope:3,mask:'8',wrapped:false}};
  const result=await authorize(service,{address:owner},[owner,other],input);
  assert.equal(await verifyTypedData({...eligibilityTypedData(resolver,input,result.authorization),address:signer.address,signature:result.signature}),true);
  assert.equal(await verifyTypedData({...eligibilityTypedData(resolver,{...input,event:1},result.authorization),address:signer.address,signature:result.signature}),false);
  const second=await authorize(service,{address:owner},[owner,other],input);assert.notEqual(result.authorization.nonce,second.authorization.nonce);assert.notEqual(result.authorization.accountCommitment,second.authorization.accountCommitment);
  const data=encodeFunctionData({abi:holderResolverAbi,functionName:'dispute',args:[0,1,hash,input.evidenceURI,result.authorization,result.signature]});
  assert.equal(pilotCall({to:resolver,data,manifest:f.manifest})?.name,'dispute');
  const legacy={...f.manifest};delete legacy.challengePolicy;assert.equal(pilotCall({to:resolver,data,manifest:legacy}),null);
  await assert.rejects(authorize(service,{},[owner],input),/Both wallets/);
  await assert.rejects(authorize(service,{},[other],input),/Both wallets/);
  eligible=false;await assert.rejects(authorize(service,{},[owner,other],input),/No qualifying shares/);
  eligible=true;await assert.rejects(holderAuthorizer({env:{}})(service,{},[owner,other],input),/unavailable/);
  await assert.rejects(holderAuthorizer({env:{FLURBO_CHALLENGE_AUTHORIZATION_KEY:'0x'+'20'.repeat(32)}})(service,{},[owner,other],input),/unavailable/);
});
