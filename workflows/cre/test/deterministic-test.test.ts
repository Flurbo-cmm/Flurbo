import { test, expect } from 'bun:test';
import { prepareDeterministicTest } from '../src/deterministic-test';
import { preparePilot } from '../src/pilot-config';
import { settlementEvent, settlementBindings } from '../../../apps/web/server/settlement-publication.mjs';
const selection={creator:'0x0000000000000000000000000000000000000004',reviewers:[1,2,3].map(i=>({name:`Test reviewer ${i}`,address:`0x${String(i).padStart(40,'0')}`}))};
const now=1800000000;
test('fresh official-source recipe uses two fixed future intervals and explicit bounded catalogue snapshots',()=>{
  const prepared=prepareDeterministicTest(selection,now),p=prepared.publication,rules=p.settlementRules as any[],close=p.draft.closesAt;
  expect(p.mode).toBe('deterministic-source-v1');expect(close).toBe(now+5400);expect(rules).toHaveLength(2);
  expect(rules.map(r=>r.source.adapter)).toEqual(['usgs-earthquake-count.v1','usgs-earthquake-count.v1']);
  expect(rules.map(r=>r.vintage)).toEqual(['first-observed-snapshot','first-observed-snapshot']);
  expect(rules[0].observation.period).not.toBe(rules[1].observation.period);
  expect(rules[1].timing.observationEndsAt+3600-now).toBe(20880);
  for(const r of rules)expect(r.timing.scheduledAt-Date.parse(r.observation.period.split('/')[1])/1000).toBe(3*3600);
  for(const r of rules){
    const url=new URL(r.source.urls[0]);expect(url.origin).toBe('https://earthquake.usgs.gov');expect(url.searchParams.has('limit')).toBe(false);
    expect(r.question).toContain('first retained USGS catalogue snapshot');
    expect(r.timing.publicationCutoff-r.timing.scheduledAt).toBe(300);
  }
  expect(settlementBindings(p).configHash).toBe(prepared.configHash);
  expect(prepareDeterministicTest(selection,now+60,close).configHash).toBe(prepared.configHash);
  expect(()=>prepareDeterministicTest(selection,now,now+3600)).toThrow();
});
test('USGS publication rejects a partial query, source switch or release-vintage misdescription',()=>{
  for(const change of [(r:any)=>{r.source.urls[0]+='&limit=1';},(r:any)=>{r.source.urls[0]=r.source.urls[0].replace('earthquake.usgs.gov','attacker.example.org');},
    (r:any)=>{r.vintage='initial';},(r:any)=>{r.observation.period=r.observation.period.split('/').reverse().join('/');}]){
    const p:any=structuredClone(prepareDeterministicTest(selection,now).publication);change(p.settlementRules[0]);
    expect(()=>{p.draft.events[0]=settlementEvent(p.settlementRules[0]);preparePilot(p,now);}).toThrow();
  }
});
