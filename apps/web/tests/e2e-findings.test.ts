import test from 'node:test';
import assert from 'node:assert/strict';
import {portfolioOrder} from '../src/portfolio-order.ts';
import {researchBlock} from '../src/agent-research.ts';
import {settlementView} from '../src/market-detail.ts';

const group=(namespace:string,closesAt:number)=>({namespace,label:namespace,pool:'0x'+'1'.repeat(40),closesAt}) as any;

test('portfolio reads open markets first, soonest close first, then closed ones newest first',()=>{
  const now=1_000;
  const order=portfolioOrder([group('old',100),group('later',3_000),group('recent',900),group('soon',2_000)],now).map(g=>g.namespace);
  assert.deepEqual(order,['soon','later','recent','old']);
});

test('research settings cover every question of every market and allow the hosts settlement reads',()=>{
  const text=researchBlock(['practice-a','pilot'],{'practice-a':['https://api.nbp.pl/x.json','https://rpc.monad.xyz/'],pilot:[null,'not a url']},{'practice-a':2,pilot:3});
  assert.ok(text.startsWith('"research": {')&&text.endsWith('},'));
  const parsed=JSON.parse(text.slice('"research": '.length,-1));
  assert.deepEqual(parsed.retriever.allowHosts,['github.com','api.nbp.pl','rpc.monad.xyz']);
  assert.deepEqual(parsed.evidenceRequirements.pilot.map((r:any)=>r.event),[0,1,2]);
  assert.ok(parsed.evidenceRequirements['practice-a'].every((r:any)=>r.freshness==='background'));
  assert.deepEqual(parsed.retriever.extraSources,{'practice-a':[],pilot:[]});
});

test('a question shows its own expected result time; payouts wait for the last question in the pool',()=>{
  const event=(end:number)=>({observationEndsAt:end});
  const state:any={cases:[{phase:0,assertionDeadline:'9999999999'},{phase:0,assertionDeadline:'9999999999'}],delivered:false,snapshot:{timestamp:0},
    manifest:{publication:{challengePeriod:3600,assertionPeriod:3600,votingPeriod:3600,draft:{closesAt:10,events:[event(1_000),event(5_000)]}}}};
  assert.equal(settlementView(state,0).expectedFrom,4_600);
  assert.equal(settlementView(state,0).payoutsFrom,8_600);
  assert.equal(settlementView(state,1).expectedFrom,8_600);
});
