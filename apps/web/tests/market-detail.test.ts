import {test} from 'node:test';
import assert from 'node:assert/strict';
import {marketHref,settlementView} from '../src/market-detail.ts';
import {pilotFixture} from './pilot-fixture.ts';
test('market URLs bind collections and outcomes; settlement follows resolver state rather than fabricated dates',async()=>{
  assert.equal(marketHref('practice-'+'12'.repeat(20),1,false),'/markets/practice-'+'12'.repeat(20)+'/1?answer=no');
  const f=pilotFixture(),s=await f.service.status();
  assert.equal(settlementView(s,0).title,'Open for predictions');
  s.snapshot.timestamp=s.manifest.publication.draft.events[0].observationEndsAt;
  assert.equal(settlementView(s,0).title,'Resolving');
  const pending={...s,cases:s.cases.map(c=>({...c}))};pending.snapshot={...s.snapshot,timestamp:Number(pending.cases[0].assertionDeadline)};
  assert.equal(settlementView(pending,0).title,'Settling as void');assert.equal(settlementView(pending,0).lapsed,true);
  pending.snapshot.timestamp-=1;assert.equal(settlementView(pending,0).lapsed,false);
  s.cases[0].phase=1;s.cases[0].proposal=2;s.cases[0].challengeUntil='1800000000';
  assert.equal(settlementView(s,0).title,'Proposed Yes');assert.equal(settlementView(s,0).deadline,1800000000);
  s.cases[0].phase=3;s.cases[0].result=3;
  assert.equal(settlementView(s,0).title,'Result confirmed');assert.equal(settlementView(s,0).result,'Void');
  s.delivered=true;assert.equal(settlementView(s,0).title,'Settled');
});
