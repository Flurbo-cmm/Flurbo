import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pilotFixture } from './pilot-fixture.ts';
import { pilotService } from '../server/pilot.mjs';

test('catalog quotes four separate events at a verified block, without wallet permissions',async()=>{
  const f=pilotFixture();
  f.manifest.publication.draft.events.push(...f.manifest.publication.draft.events.map((e:any,i:number)=>({...e,id:'four-'+i})));
  const service=pilotService({manifest:f.manifest,rpc:f.rpc});
  const catalog=await service.markets();
  assert.equal(catalog.open,true);assert.equal(catalog.prices.length,4);
  assert.deepEqual(catalog.prices.map((p:any)=>p.event),[0,1,2,3]);
  assert.ok(catalog.prices.every((p:any)=>p.yes==='250000'&&p.no==='250000'));
  f.options.changed=true;await assert.rejects(service.markets(),/anchor/);
});
test('closed markets keep their questions but do not offer executable prices',async()=>{
  const f=pilotFixture();f.manifest.publication.draft.closesAt=1;
  const data=await f.service.markets();
  assert.equal(data.open,false);assert.ok(data.prices.every((p:any)=>p.yes===null&&p.no===null));
});
