import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requestScheduler,retryAfterMs} from '../src/request-scheduler.ts';
import {createClient} from '../src/client.ts';

test('reads respect a full Retry-After and mutations are not replayed',async()=>{
  const delays:number[]=[];let attempts=0;
  const client=createClient({transport:{kind:'fixture',async send(){attempts++;return{status:429,body:{},retryAfter:'60'};}},sleep:async ms=>{delays.push(ms);}});
  await assert.rejects(client.directory());assert.equal(attempts,3);assert.deepEqual(delays,[60000,60000]);
  attempts=0;await assert.rejects(client.agents.create({}));assert.equal(attempts,1);
  assert.equal(retryAfterMs('Thu, 01 Jan 1970 00:01:00 GMT',0),60000);
});
test('scheduler bounds concurrency, queue size and cancellation',async()=>{
  const s=requestScheduler({concurrency:1,queueLimit:1});let release!:()=>void;
  const first=s.run(()=>new Promise<void>(r=>{release=r;}));const abort=new AbortController();let sent=false;
  const second=s.run(async()=>{sent=true;},abort.signal);await assert.rejects(s.run(async()=>{}),/queue full/);
  abort.abort();await assert.rejects(second);release();await first;assert.equal(sent,false);await s.run(async()=>{});
});
test('scheduler retains rate and cooldown budgets across calls',async()=>{
  let now=1000;const s=requestScheduler({perWindow:1,windowMs:100,now:()=>now});await s.run(async()=>{});
  const a=new AbortController();const blocked=s.run(async()=>assert.fail('must not send'),a.signal);a.abort();await assert.rejects(blocked);
  now+=101;await s.run(async()=>{});s.cooldown('60');now+=1000;
  const b=new AbortController();const cooling=s.run(async()=>assert.fail('must not send'),b.signal);b.abort();await assert.rejects(cooling);
  now+=60001;await s.run(async()=>{});
});
test('cancellation interrupts a long Retry-After without another attempt',async()=>{
  let calls=0;const abort=new AbortController();
  const client=createClient({transport:{kind:'fixture',async send(){calls++;return{status:429,body:{},retryAfter:'60'};}}});
  const pending=client.directory(abort.signal);setTimeout(()=>abort.abort(),10);
  await assert.rejects(pending,(e:any)=>e.code==='aborted');assert.equal(calls,1);
});
