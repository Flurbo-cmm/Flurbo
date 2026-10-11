import test from 'node:test';
import assert from 'node:assert/strict';
import {portfolioOrder} from '../src/portfolio-order.ts';
import {researchBlock} from '../src/agent-research.ts';

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

