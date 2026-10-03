import assert from 'node:assert/strict';
import {test} from 'node:test';
import {encodeClaim,claimScenarios,decodeClaim,CLAIM_RULES,validateClaim} from '../shared/claims.mjs';
import {certifiedClaim,certifiedPair} from '../server/pair-math.mjs';
import {describeClaim,describeClaimAnswers} from '../src/portfolio.ts';

test('canonical claims respect ascending event bits, inclusive OR and exact-one rather than odd parity',()=>{
  const legs=[{event:2,yes:true},{event:0,yes:false}];
  assert.deepEqual(encodeClaim({events:4,legs,rule:'AND'}),{schema:'flurbo.claim.v1',scope:5,mask:'4'});
  assert.equal(encodeClaim({events:4,legs,rule:'OR'}).mask,'13');
  assert.equal(encodeClaim({events:4,legs,rule:'EXACTLY_ONE'}).mask,'9');
  const three=[0,1,2].map(event=>({event,yes:true}));
  assert.equal(encodeClaim({events:4,legs:three,rule:'EXACTLY_ONE'}).mask,'22');
  assert.equal(encodeClaim({events:4,legs:three,rule:'AT_LEAST_TWO'}).mask,'232');
  assert.equal(claimScenarios(7,'22',4)[7].wins,false);
  assert.equal(claimScenarios(7,'232',4)[7].wins,true);
  assert.equal(describeClaimAnswers(7,22),'Exactly one of: Yes / Yes / Yes');
  assert.match(describeClaim(7,232,['Alpha','Beta','Gamma']),/At least two of: Alpha \(Yes\)/);
});

test('all named rules round-trip and reject empty, duplicate, out-of-pool and four-event claims',()=>{
  for(const indices of [[0],[0,2],[0,1,3]]) for(let state=0;state<2**indices.length;state++)for(const rule of CLAIM_RULES){
    if(rule==='AT_LEAST_TWO'&&indices.length===1)continue;
    const encoded=encodeClaim({events:4,rule,legs:indices.map((event,i)=>({event,yes:!!(state&(1<<i))}))});
    const decoded=decodeClaim(encoded.scope,encoded.mask)!;
    assert.equal(encodeClaim({events:4,...decoded}).mask,encoded.mask);
  }
  for(const legs of [[],[{event:0,yes:true},{event:0,yes:false}],[0,1,2,3].map(event=>({event,yes:true})),[{event:4,yes:true}]])assert.throws(()=>encodeClaim({events:4,legs,rule:'AND'}));
  assert.throws(()=>encodeClaim({events:2,legs:[{event:2,yes:true}],rule:'OR'}));
  for(const mask of ['0','15','16','-1','6.0','06'])assert.throws(()=>validateClaim(3,mask,2));
});

test('claim probabilities match independent enumeration for every local mask, including complements and mixed answers',()=>{
  const state={events:3,liquidity:'10000000',order:[0,1,2],factors:[{scope:7,values:['0','2000000','1000000','6000000','3000000','7000000','4000000','11000000']}]};
  const w=state.factors[0].values.map(v=>Math.exp(Number(v)/1e7)),z=w.reduce((a,b)=>a+b,0),p=w.map(v=>v/z);
  const marginals=[0,1,2].map(i=>p.reduce((v,weight,s)=>v+((s&(1<<i))?weight:0),0));
  for(let mask=1;mask<255;mask++){
    const expected=p.reduce((v,weight,s)=>v+((mask&(1<<s))?weight:0),0);
    let independent=0;
    for(let s=0;s<8;s++)if(mask&(1<<s))independent+=marginals.reduce((v,m,i)=>v*((s&(1<<i))?m:1-m),1);
    const result=certifiedClaim(state,7,String(mask));
    assert.equal(result.values.market,Math.round(expected*1000));
    assert.equal(result.values.independent,Math.round(independent*1000));
    assert.equal(result.values.difference,Math.sign(expected-independent)*Math.round(Math.abs(expected-independent)*1000)||0);
  }
  const pair=certifiedPair({...state,a:0,b:2});
  assert.equal(certifiedClaim(state,5,'8').values.market,pair.values.joint);
  const uniform={...state,factors:[]};
  assert.deepEqual(certifiedClaim(uniform,7,'22').values,{market:375,independent:375,difference:0});
  assert.deepEqual(certifiedClaim(uniform,7,'232').values,{market:500,independent:500,difference:0});
  assert.deepEqual(certifiedClaim(uniform,3,'14').values,{market:750,independent:750,difference:0});
});
