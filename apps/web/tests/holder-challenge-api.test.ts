import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {privateKeyToAccount} from 'viem/accounts';
import {verifyTypedData} from 'viem';
import {localApi} from '../server/local-api.mjs';
import {eligibilityTypedData} from '../shared/holder-challenge.mjs';
import {pilotFixture,hash} from './pilot-fixture.ts';

test('challenge API uses verified account links, checks live holdings, and issues only bound authorizations',async()=>{
  const account='0x'+'99'.repeat(20),otherAccount='0x'+'88'.repeat(20);
  const payer=privateKeyToAccount(('0x'+'12'.repeat(32)) as `0x${string}`),holder=privateKeyToAccount(('0x'+'13'.repeat(32)) as `0x${string}`);
  const key=('0x'+'19'.repeat(32)) as `0x${string}`,authority=privateKeyToAccount(key),now=Math.floor(Date.now()/1000),f=pilotFixture(now);
  const hosts:string[]=[],prepared:any[]=[],calls:any[]=[];let eligible=true,failRead=false;
  const stake={holder:holder.address.toLowerCase(),scope:1,mask:'2',wrapped:false};
  f.manifest.challengePolicy={version:'account-holders-v1',authority:authority.address.toLowerCase()};
  const pilot={manifest:f.manifest,prepare:async(input:any)=>{prepared.push(input);return input;},
    challengeStake:async(event:number,witness:any)=>{calls.push(witness);if(failRead)throw Error('Private upstream details');return{eligible:eligible&&event===0&&JSON.stringify(witness)===JSON.stringify(stake),snapshot:{timestamp:now},challengeUntil:now+3600};},
    challengeEligibility:async(wallets:string[])=>{assert.deepEqual(wallets.sort(),[payer.address.toLowerCase(),holder.address.toLowerCase()].sort());return{eligible,stake:eligible?stake:null,nextCursor:null};}};
  const api=localApi({hosts,pilot,challengeOptions:{env:{FLURBO_CHALLENGE_AUTHORIZATION_KEY:key},now:()=>now},store:{read:async(sid:string)=>sid==='a'||sid==='b'?{address:sid==='a'?account:otherAccount,method:'passkey'}:null}});
  const server=createServer((req,res)=>api(req,res,()=>{res.statusCode=404;res.end();}));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const host=`127.0.0.1:${(server.address() as any).port}`;hosts.push(host);const origin=`http://${host}`;
  const call=(path:string,body:any,sid='a',site=origin)=>fetch(origin+'/api/'+path,{method:'POST',headers:{Origin:site,'Content-Type':'application/json',Cookie:`flurbo_session=${sid}`},body:JSON.stringify(body)});
  const input={owner:payer.address.toLowerCase(),action:'dispute',event:0,outcome:1,evidenceHash:hash,evidenceURI:'https://example.org/evidence',stake};
  try{
    assert.equal((await call('pilot/prepare',input,'')).status,401);
    assert.equal((await call('pilot/prepare',input)).status,403);
    for(const signer of [payer,holder]){
      const proof=await(await call('account/wallets/challenge',{wallet:signer.address})).json();
      assert.equal((await call('account/wallets/verify',{id:proof.id,signature:await signer.signMessage({message:proof.message})})).status,200);
    }
    assert.equal((await call('pilot/challenge-eligibility',{owner:input.owner,event:0})).status,200);
    assert.equal((await call('pilot/challenge-eligibility',{owner:input.owner,event:0,wallets:[stake.holder]})).status,400);
    assert.equal((await call('pilot/prepare',input,'b')).status,403);
    assert.equal((await call('pilot/prepare',input,'a','https://attacker.example')).status,403);
    assert.equal((await call('pilot/prepare',{...input,stake:{...stake,holder:otherAccount}})).status,403);
    assert.equal((await call('pilot/prepare',{...input,signature:'0x'})).status,400);
    eligible=false;assert.equal((await call('pilot/prepare',input)).status,403);assert.equal(prepared.length,0);
    eligible=true;failRead=true;const failed=await call('pilot/prepare',input);assert.notEqual(failed.status,200);assert.doesNotMatch(await failed.text(),/Private upstream/);assert.equal(prepared.length,0);
    failRead=false;const response=await call('pilot/prepare',input);assert.equal(response.status,200);
    const result=await response.json();assert.equal(prepared.length,1);assert.equal(result.stake,undefined);
    assert.equal(result.authorization.holder,stake.holder);assert.equal(result.authorization.challenger,input.owner);
    assert.equal(await verifyTypedData({...eligibilityTypedData(f.manifest.resolver,input,result.authorization),address:authority.address,signature:result.signature}),true);
    // An old pool gets the same application gate but no invented contract authorization.
    delete f.manifest.challengePolicy;
    assert.equal((await call('pilot/prepare',input)).status,200);assert.equal(prepared[1].authorization,undefined);
    eligible=false;assert.equal((await call('pilot/prepare',input)).status,403);assert.ok(calls.length>0);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
