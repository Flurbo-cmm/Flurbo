import {encodeClaim, validateClaim} from './claims.mjs';

export const THESIS_DENOMINATOR = 100_000_000n;
export function percentageBps(value) {
  if(typeof value!=='string'||! /^(?:0|[1-9][0-9]?|100)(?:\.[0-9]{1,2})?$/.test(value))return null;
  const [whole,fraction='']=value.split('.');
  const bps=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  return bps<=10000?bps:null;
}
// State bit 0 is A, bit 1 is B. Products stay exact through claim evaluation.
export function thesisDistribution(a,r,s) {
  if(![a,r,s].every(v=>Number.isInteger(v)&&v>=0&&v<=10000))throw Error('Enter three percentages between 0 and 100.');
  const A=BigInt(a),R=BigInt(r),S=BigInt(s),D=10000n;
  return [(D-A)*(D-S),A*(D-R),(D-A)*S,A*R];
}
export function thesisCandidates(events,a,b,yesA=true,yesB=true) {
  if(!Number.isInteger(a)||!Number.isInteger(b)||a===b||Math.min(a,b)<0||Math.max(a,b)>=events||typeof yesA!=='boolean'||typeof yesB!=='boolean')throw Error('Choose two different questions.');
  return ['SINGLE','AND','OR','EXACTLY_ONE'].map(id=>{
    const legs=id==='SINGLE'?[{event:b,yes:yesB}]:[{event:a,yes:yesA},{event:b,yes:yesB}];
    const rule=id==='SINGLE'?'AND':id;
    return {id,rule,legs,...encodeClaim({events,legs,rule})};
  });
}
export function scenarioWins(claim,events,a,b,state) {
  const selected=validateClaim(claim.scope,claim.mask,events);
  if(selected.some(e=>e!==a&&e!==b)||!Number.isInteger(state)||state<0||state>3)throw Error('Invalid thesis scenario.');
  const local=selected.reduce((n,event,i)=>n|(((state>>(event===a?0:1))&1)<<i),0);
  return !!(BigInt(claim.mask)&(1n<<BigInt(local)));
}
export function thesisProbability(distribution,claim,events,a,b) {
  if(!Array.isArray(distribution)||distribution.length!==4||distribution.some(v=>typeof v!=='bigint'||v<0n)||distribution.reduce((n,v)=>n+v,0n)!==THESIS_DENOMINATOR)throw Error('Invalid distribution.');
  return distribution.reduce((n,p,state)=>n+(scenarioWins(claim,events,a,b,state)?p:0n),0n);
}
// Matches the pool's uniform completion rule for VOID, including floor to atoms.
export function thesisPayout(claim,events,a,b,outcomeA,outcomeB,quantity) {
  if(![true,false,null].includes(outcomeA)||![true,false,null].includes(outcomeB)||typeof quantity!=='bigint'||quantity<0n)throw Error('Invalid payout input.');
  const states=[0,1,2,3].filter(s=>(outcomeA===null||!!(s&1)===outcomeA)&&(outcomeB===null||!!(s&2)===outcomeB));
  return quantity*BigInt(states.filter(s=>scenarioWins(claim,events,a,b,s)).length)/BigInt(states.length);
}
export function thesisQuantity(value) {
  if(typeof value!=='string'||! /^(0|[1-9][0-9]{0,2})(\.[0-9]{1,6})?$/.test(value))return null;
  const [whole,fraction='']=value.split('.'),atoms=BigInt(whole)*1_000_000n+BigInt(fraction.padEnd(6,'0'));
  return atoms>0n&&atoms<=100_000_000n?atoms:null;
}
export function validateThesisInput(input,events) {
  if(!input||Array.isArray(input)||Object.keys(input).sort().join(',')!=='a,b,quantity,yesA,yesB'||typeof input.quantity!=='string'||! /^[1-9][0-9]{0,8}$/.test(input.quantity)||BigInt(input.quantity)>100_000_000n)throw Error('Invalid thesis input.');
  return thesisCandidates(events,input.a,input.b,input.yesA,input.yesB);
}
