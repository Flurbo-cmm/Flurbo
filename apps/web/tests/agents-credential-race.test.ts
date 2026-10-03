import assert from 'node:assert/strict';
import {test} from 'node:test';
import {alice,setup} from './agent-fixture.ts';

// A request that authenticated before a revocation or rotation must never restore the credential when it
// records its last use afterwards. Two API instances share one Redis (the fake, or a real isolated Redis
// with FLURBO_TEST_REDIS_URL). Instance B's request is held exactly at its last-use write while instance A
// revokes or rotates, then released: the interleaving is fixed, not left to timing.
type Setup=ReturnType<typeof setup>;
const ALL=['markets:read','wallet:read','runtime:report','executions:report'];
const rt=(which:any,token:string,path='session')=>which.runtime({method:'GET',path:'/api/agent-runtime/v1/'+path,headers:{authorization:'Bearer '+token,'flurbo-agent-protocol':'1'},body:''});

// Any write that records a credential's use: the last-use raise, or a write of a credential record itself.
const isUseWrite=(op:string,a:any[])=>(op==='EVAL'&&String(a[0]).includes('tonumber'))||(op==='SET'&&/:credential:[0-9a-f]{16}$/.test(String(a[0])));

function gatedInstance(s:Setup){
  let arrived!:()=>void,release!:()=>void,armed=true;
  const atWrite=new Promise<void>(r=>{arrived=r;}),open=new Promise<void>(r=>{release=r;});
  const command=async(op:string,...a:any[])=>{
    if(armed&&isUseWrite(op,a)){armed=false;arrived();await open;}
    return s.redis.command(op,...a);
  };
  return {api:s.make({command}),atWrite,release};
}

async function issued(s:Setup){
  const agent=(await s.call(alice,'POST','/api/agents',{kind:'runtime',name:'Race agent',markets:['pilot']})).body;
  const r=await s.call(alice,'POST',`/api/agents/${agent.id}/credentials`,{scopes:ALL,ttlDays:30,label:'race'});
  assert.equal(r.status,200,JSON.stringify(r.body));
  return {agentId:agent.id as string,token:r.body.token as string,id:r.body.credential.credentialId as string};
}
const stored=async(s:Setup,id:string)=>JSON.parse((await s.redis.get(`flurbo:agents:v1:credential:${id}`))!);
const listed=async(s:Setup,agentId:string,id:string)=>(await s.call(alice,'GET',`/api/agents/${agentId}`)).body.runtime.credentials.find((c:any)=>c.credentialId===id);

test('a request in flight across a revocation on another instance cannot restore the credential',async()=>{
  const s=setup(),{agentId,token,id}=await issued(s),b=gatedInstance(s);
  const before=await stored(s,id);
  const inFlight=rt(b.api,token);
  await b.atWrite;  // B has authenticated and is about to record the use
  s.advance(5);
  const revoked=await s.call(alice,'POST',`/api/agents/${agentId}/credentials/${id}/revoke`,{});
  assert.equal(revoked.body.status,'revoked');
  b.release();
  assert.equal((await inFlight).status,200,'the request that authenticated before revocation completes');
  const after=await stored(s,id);
  assert.equal(after.revokedAt,before.createdAt+5,'revocation survives the late write');
  for(const k of ['scopes','expiresAt','secretSha256','owner','agentId','account'])assert.deepEqual(after[k],before[k],k);
  for(const which of [s.api,b.api,s.make()])assert.equal((await rt(which,token)).body.code,'CREDENTIAL_REVOKED','every instance refuses it');
  const shown=await listed(s,agentId,id);
  assert.equal(shown.status,'revoked');
  assert.equal(shown.lastUsedAt,before.createdAt,'the last use is still recorded, in its own key');
});

test('a request in flight across a rotation on another instance cannot restore the old credential',async()=>{
  const s=setup(),{agentId,token,id}=await issued(s),b=gatedInstance(s);
  const before=await stored(s,id);
  const inFlight=rt(b.api,token);
  await b.atWrite;
  const rotated=(await s.call(alice,'POST',`/api/agents/${agentId}/credentials/${id}/rotate`,{})).body;
  b.release();
  assert.equal((await inFlight).status,200);
  const after=await stored(s,id);
  assert.ok(after.revokedAt,'the old credential stays revoked');
  assert.equal(after.rotatedTo,rotated.credential.credentialId,'the rotation link survives');
  for(const k of ['scopes','expiresAt','secretSha256'])assert.deepEqual(after[k],before[k],k);
  for(const which of [s.api,b.api])assert.equal((await rt(which,token)).body.code,'CREDENTIAL_REVOKED');
  assert.equal((await rt(b.api,rotated.token)).status,200,'the new credential works on every instance');
  assert.equal((await rt(s.api,rotated.token)).status,200);
});

test('last use only moves forward and never touches the credential record',async()=>{
  const s=setup(),{agentId,token,id}=await issued(s),record=await stored(s,id);
  await rt(s.api,token);
  s.advance(120);await rt(s.make(),token);
  const later=(await listed(s,agentId,id)).lastUsedAt;
  assert.equal(later,record.createdAt+120);
  // An older timestamp arriving late (a slow instance) does not lower it.
  await s.redis.command('EVAL',"local e=tonumber(redis.call('GET',KEYS[1]) or '0') if tonumber(ARGV[1])>e then redis.call('SET',KEYS[1],ARGV[1]) return 1 end return 0",1,`flurbo:agents:v1:credential-used:${id}`,String(record.createdAt));
  assert.equal((await listed(s,agentId,id)).lastUsedAt,later);
  assert.deepEqual(await stored(s,id),record,'the credential record is byte-for-byte unchanged by use');
});
