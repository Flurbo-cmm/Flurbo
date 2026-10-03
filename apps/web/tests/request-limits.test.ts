import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requestLimits,CapacityError} from '../server/request-limits.mjs';
import {createRpcCapacity} from '../server/rpc-capacity.mjs';
import {localApi} from '../server/local-api.mjs';
import {fakeRedis,setup,alice,bob} from './agent-fixture.ts';
import {pilotFixture} from './pilot-fixture.ts';
import {pilotService} from '../server/pilot.mjs';

test('account budgets are shared across instances and isolated from other accounts',async()=>{
  let now=1800000000000;const {command}=fakeRedis(),a=requestLimits({command,now:()=>now}),b=requestLimits({command,now:()=>now});
  await a.take('account:a',3,2);await b.take('account:a',3);
  await assert.rejects(b.take('account:a',3),CapacityError);await b.take('account:b',3);
  now+=60000;await a.take('account:a',3);
  await assert.rejects(requestLimits({command:async()=>{throw Error('offline')}}).take('account:a',3),/offline/);
});

test('anonymous preview saturation does not block authenticated traffic or login session reads',async()=>{
  const {command}=fakeRedis();const store={command,read:async(sid:string)=>sid==='owner'?{address:alice,method:'passkey'}:null};
  const api=localApi({publicOrigin:'https://flurbo.singu.online',rpcUrl:'https://testnet-rpc.monad.xyz',store});
  const call=async(path:string,cookie?:string)=>{let status=0;await api({url:path,method:'GET',headers:{host:'flurbo.singu.online',cookie}},
    {setHeader(){},writeHead(s:number){status=s},end(){}},()=>{});return status;};
  for(let i=0;i<600;i++)assert.equal(await call('/api/preview'),200);
  assert.equal(await call('/api/preview'),429);
  assert.equal(await call('/api/network','flurbo_session=owner'),200);
  assert.equal(await call('/api/auth/session'),200);
});

test('runtime account limit survives credential multiplication and leaves other accounts usable',async()=>{
  const s=setup();const make=async(login:string)=>{
    const a=(await s.call(login,'POST','/api/agents',{kind:'runtime',name:'Capacity test',markets:['pilot']})).body;
    const tokens=[];for(let i=0;i<3;i++)tokens.push((await s.call(login,'POST',`/api/agents/${a.id}/credentials`,{scopes:['markets:read']})).body.token);return tokens;
  };
  const tokens=await make(alice),other=(await make(bob))[0];
  const call=(token:string)=>s.api.runtime({method:'GET',path:'/api/agent-runtime/v1/session',headers:{authorization:'Bearer '+token,'flurbo-agent-protocol':'1'},body:'',hosted:true});
  for(let i=0;i<240;i++)assert.equal((await call(tokens[i%3])).status,200);
  assert.equal((await call(tokens[0])).status,429);assert.equal((await call(other)).status,200);
  // Invalid credentials have a separate service allowance.
  for(let i=0;i<310;i++)await call('invalid');
  assert.equal((await call(other)).status,200);
});

test('RPC queue bounds concurrency, cancels queued work, and keeps slots until bodies complete',async()=>{
  const run=createRpcCapacity({concurrency:1,maxQueued:1});let finish!:()=>void,calls=0;
  const req=async()=>{calls++;return new Response(new ReadableStream({start(c){finish=()=>{c.enqueue(new TextEncoder().encode('{}'));c.close();};}}));};
  const init={body:JSON.stringify({method:'eth_call'}),signal:undefined};
  const first=run(req,'https://rpc.example',init);await new Promise(r=>setImmediate(r));
  const abort=new AbortController(),second=run(req,'https://rpc.example',{...init,signal:abort.signal});
  await assert.rejects(run(req,'https://rpc.example',init),CapacityError);abort.abort();await assert.rejects(second);assert.equal(calls,1);
  finish();await first;
  assert.equal((await run(async()=>Response.json({}), 'https://rpc.example',init)).status,200);
});

test('RPC weighted budget counts batch methods and upstream cooldown prevents another send',async()=>{
  let now=1800000000000;const {command}=fakeRedis();const a=createRpcCapacity({command,now:()=>now,unitsPerMinute:3}),b=createRpcCapacity({command,now:()=>now,unitsPerMinute:3});
  let calls=0;const request=async()=>{calls++;return Response.json({});};const init={body:JSON.stringify({method:'eth_call'})};
  await a(request,'https://rpc.example',init);await assert.rejects(b(request,'https://rpc.example',init),CapacityError);assert.equal(calls,1);
  const run=createRpcCapacity({now:()=>now});
  await assert.rejects(run(async()=>new Response('{}',{status:429,headers:{'Retry-After':'60'}}),'https://rpc.example',init),CapacityError);
  now+=11000;await assert.rejects(run(request,'https://rpc.example',init),CapacityError);assert.equal(calls,1);
  now+=50000;await run(request,'https://rpc.example',init);assert.equal(calls,2);
});

test('concurrent market reads share one batch without retaining stale prices',async()=>{
  const f=pilotFixture(undefined,4);let batches=0,reads=0;
  const rpc=Object.assign(async(method:string,params:any[])=>{reads++;return f.rpc(method,params);},{readBatch:async(calls:any[])=>{batches++;assert.equal(calls.length,8);return calls.map(()=>250000n);}});
  const service=pilotService({manifest:f.manifest,rpc});
  const [a,b]=await Promise.all([service.markets(),service.markets()]);
  assert.deepEqual(a,b);assert.equal(batches,1);assert.equal(reads,9);
  await service.markets();assert.equal(batches,2,'later requests read again, not cached quotes');
  f.options.changed=true;await assert.rejects(service.markets(),/anchor/);
  f.options.changed=false;await service.markets();assert.equal(batches,3,'failed in-flight reads are cleared');
});

test('on a single server, rate windows and session reads stay in memory instead of costing Redis commands', async () => {
  const { memoryWindow } = await import('../server/request-limits.mjs');
  const { RedisSessionStore } = await import('../server/redis-session.mjs');
  let t = 1_800_000_000_000; const count = memoryWindow(() => t);
  assert.equal(await count('a', 60), 1); assert.equal(await count('a', 60), 2); assert.equal(await count('b', 60), 1);
  t += 61_000; assert.equal(await count('a', 60), 1, 'window expired');
  // Page traffic: no EVAL for limits, and one session GET for many requests.
  const {command} = fakeRedis(); const seen: string[] = [];
  const counted = async (...c: any[]) => { seen.push(c[0]); return command(...c); };
  await counted('SET', 'flurbo:auth:v1:session:' + (await import('node:crypto')).createHash('sha256').update('owner').digest('hex'),
    JSON.stringify({ method: 'passkey', origin: 'https://flurbo.singu.online', address: alice, expiresAt: Date.now() + 3_600_000 }));
  seen.length = 0;
  const store = new RedisSessionStore(counted);
  const api = localApi({ publicOrigin: 'https://flurbo.singu.online', rpcUrl: 'https://testnet-rpc.monad.xyz', store, sharedLimits: false });
  const call = async () => { let status = 0; await api({ url: '/api/network', method: 'GET', headers: { host: 'flurbo.singu.online', cookie: 'flurbo_session=owner' } },
    { setHeader() {}, writeHead(s: number) { status = s; }, end() {} }, () => {}); return status; };
  for (let i = 0; i < 5; i++) assert.equal(await call(), 200);
  assert.deepEqual(seen, ['GET'], 'five requests: one session read, no limit scripts');
  await store.revoke('owner'); seen.length = 0;
  assert.equal(await store.read('owner', 'https://flurbo.singu.online'), null, 'sign-out takes effect at once');
  assert.deepEqual(seen, ['GET']);
  // The shared mode (several servers) still counts in Redis.
  const shared = localApi({ publicOrigin: 'https://flurbo.singu.online', rpcUrl: 'https://testnet-rpc.monad.xyz', store: new RedisSessionStore(counted) });
  seen.length = 0; await shared({ url: '/api/network', method: 'GET', headers: { host: 'flurbo.singu.online', cookie: 'flurbo_session=x' } }, { setHeader() {}, writeHead() {}, end() {} }, () => {});
  assert.ok(seen.includes('EVAL'));
});
