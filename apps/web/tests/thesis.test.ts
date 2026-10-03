import assert from 'node:assert/strict';
import {test} from 'node:test';
import {percentageBps,thesisDistribution,thesisCandidates,thesisProbability,thesisPayout,thesisQuantity,scenarioWins,validateThesisInput,THESIS_DENOMINATOR} from '../shared/thesis.mjs';
import {assertCheckoutBinding} from '../src/checkout.ts';

test('forecasts form a complete exact joint distribution, not a conditional bet or independent product',()=>{
  // P(A)=30%, P(B|A)=80%, P(B|not A)=20% gives P(B)=38%, P(A AND B)=24%.
  const d=thesisDistribution(3000,8000,2000),claims=thesisCandidates(4,0,1);
  assert.deepEqual(d,[56_000_000n,6_000_000n,14_000_000n,24_000_000n]);
  assert.deepEqual(claims.map(c=>thesisProbability(d,c,4,0,1)),[38_000_000n,24_000_000n,44_000_000n,20_000_000n]);
  for(const a of [0,1,3333,5000,9999,10000])for(const r of [0,1234,10000])for(const s of [0,7890,10000]){
    const p=thesisDistribution(a,r,s);assert.equal(p.reduce((sum,x)=>sum+x,0n),THESIS_DENOMINATOR);assert.ok(p.every(x=>x>=0));
  }
  for(const bad of [-1,10001,1.1,NaN,null])assert.throws(()=>thesisDistribution(bad as any,5000,5000));
  for(const [input,expected] of [['0',0],['100.00',10000],['73.33',7333],['0.01',1]] as const)assert.equal(percentageBps(input),expected);
  for(const input of ['', '101','100.01','1e2','-1',' 50','50.123','NaN'])assert.equal(percentageBps(input),null);
  assert.equal(thesisQuantity('0.000001'),1n);assert.equal(thesisQuantity('100'),100_000_000n);
  for(const input of ['0','100.000001','1e1','1.0000001','-1'])assert.equal(thesisQuantity(input),null);
});

test('every pair orientation and Yes/No selection matches Boolean intent and full-pool VOID enumeration',()=>{
  const outcomes=[false,true,null];
  for(let a=0;a<4;a++)for(let b=0;b<4;b++)if(a!==b)for(const yesA of [false,true])for(const yesB of [false,true]){
    for(const c of thesisCandidates(4,a,b,yesA,yesB)){
      const truth=(x:boolean,y:boolean)=>c.id==='SINGLE'?y===yesB:c.id==='AND'?x===yesA&&y===yesB:c.id==='OR'?x===yesA||y===yesB:(x===yesA)!==(y===yesB);
      for(let state=0;state<4;state++)assert.equal(scenarioWins(c,4,a,b,state),truth(!!(state&1),!!(state&2)));
      // Independent enumeration of all sixteen underlying states, as PilotPool.payoutFraction does.
      for(const x of outcomes)for(const y of outcomes){
        let matches=0,total=0;
        for(let global=0;global<16;global++){
          const ax=!!(global&(1<<a)),by=!!(global&(1<<b));
          if(x!==null&&ax!==x||y!==null&&by!==y)continue;
          total++;if(truth(ax,by))matches++;
        }
        assert.equal(thesisPayout(c,4,a,b,x,y,7n),7n*BigInt(matches)/BigInt(total));
      }
    }
  }
  const and=thesisCandidates(2,0,1)[1];assert.equal(thesisPayout(and,2,0,1,false,true,10_000_000n),0n);
  assert.equal(thesisPayout(and,2,0,1,null,true,10_000_000n),5_000_000n);
  assert.equal(thesisPayout(and,2,0,1,null,null,10_000_000n),2_500_000n);
});

test('request accepts no forecast, wallet, notes or arbitrary claims; checkout pins pool and rules',()=>{
  const input={a:0,b:1,yesA:true,yesB:false,quantity:'1000000'};
  assert.equal(validateThesisInput(input,4).length,4);
  for(const bad of [null,[],{...input,a:1},{...input,a:4},{...input,quantity:'0'},{...input,quantity:'100000001'},{...input,note:'personal'},{...input,forecast:[]},{...input,owner:'wallet'},{...input,scope:3},{...input,yesB:1}])assert.throws(()=>validateThesisInput(bad,4));
  const binding={pool:'0x'+'11'.repeat(20),rulesHash:'0x'+'22'.repeat(32)};
  const draft={event:0,yes:true,legs:[0],answers:{0:true},quantity:'1',side:'buy' as const,binding};
  assert.doesNotThrow(()=>assertCheckoutBinding(draft,binding));
  assert.throws(()=>assertCheckoutBinding(draft,{...binding,pool:'0x'+'33'.repeat(20)}));
  assert.throws(()=>assertCheckoutBinding(draft,{...binding,rulesHash:'0x'+'44'.repeat(32)}));
  assert.doesNotThrow(()=>assertCheckoutBinding(null,binding));
});
