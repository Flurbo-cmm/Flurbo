// Independent outward-rounded factor elimination for pools of 1..32 events in the pool's own elimination order.
// All liability arithmetic remains integer token atoms. See docs/PROJECT_REFERENCE.md.
import {claimEvents,validateClaim} from '../shared/claims.mjs';
const S=10n**60n, U128=(1n<<128n)-1n;
const ceil=(a,b)=>(a+b-1n)/b;
const atom=v=>{if(typeof v!=='string'||! /^(0|[1-9][0-9]{0,38})$/.test(v)||BigInt(v)>U128)throw new Error('Invalid snapshot atom');return BigInt(v);};
export function validateFactorSnapshot(s) {
  if(!s||!Number.isInteger(s.events)||s.events<1||s.events>32)throw new Error('Invalid event count');
  const liquidity=atom(s.liquidity);if(!liquidity)throw new Error('Invalid liquidity');
  if(!Array.isArray(s.order)||s.order.length!==s.events||new Set(s.order).size!==s.events||s.order.some(v=>!Number.isInteger(v)||v<0||v>=s.events))throw new Error('Invalid elimination order');
  if(!Array.isArray(s.factors)||s.factors.length>64)throw new Error('Invalid factors');
  let maxima=0n;
  for(const f of s.factors){
    if(!Number.isInteger(f.scope)||f.scope<1||f.scope>=2**s.events)throw new Error('Invalid scope');
    const bits=claimEvents(f.scope).length;
    if(bits>3||!Array.isArray(f.values)||f.values.length!==2**bits)throw new Error('Invalid table');
    maxima+=f.values.map(atom).reduce((a,b)=>a>b?a:b,0n);
  }
  if(maxima>100n*liquidity)throw new Error('Snapshot exceeds numerical domain');
  // Same width limit as FactoredLmsr and the pools, checked without floats.
  let scopes=s.factors.map(f=>claimEvents(f.scope));
  for(const event of s.order){
    const joined=[...new Set([event,...scopes.filter(members=>members.includes(event)).flat()])];
    if(joined.length>3)throw new Error('Unsupported graph width');
    scopes=scopes.filter(members=>!members.includes(event));scopes.push(joined.filter(member=>member!==event));
  }
  return s;
}
export function validatePairSnapshot(s) {
  if(!s||!Number.isInteger(s.events)||s.events<2||!Number.isInteger(s.a)||!Number.isInteger(s.b)||s.a===s.b||Math.min(s.a,s.b)<0||Math.max(s.a,s.b)>=s.events)throw new Error('Invalid event pair');
  return validateFactorSnapshot(s);
}

function weight(n,d) {
  // exp(-n/d), with 0 <= n/d <= 100. Reduce by 128 so Taylor argument < 1.
  let lo=S,hi=S,termLo=S,termHi=S;
  for(let k=1n;k<=64n;k++){
    termLo=termLo*n/(d*128n*k);termHi=ceil(termHi*n,d*128n*k);
    lo+=termLo;hi+=termHi;
  }
  // Remaining positive Taylor terms <= twice the next term (ratio < 1/2).
  hi+=2n*ceil(termHi*n,d*128n*65n);
  let lower=S*S/hi,upper=ceil(S*S,lo);
  for(let k=0;k<7;k++){lower=lower*lower/S;upper=ceil(upper*upper,S);}
  return [lower,upper];
}
const sum=xs=>xs.reduce(([a,b],[c,d])=>[a+c,b+d],[0n,0n]);
const ratio=([a,b],[c,d])=>{if(c<=0n)throw new Error('Unbounded probability');return [a*S/d,ceil(b*S,c)];};
const product=([a,b],[c,d])=>[a*c/S,ceil(b*d,S)];
const rounded=v=>v<0n?-((-v*1000n+S/2n)/S):(v*1000n+S/2n)/S;
const display=bounds=>bounds&&rounded(bounds[0])===rounded(bounds[1])?Number(rounded(bounds[0])):null;
// Each factor is scaled by its own maximum, so every table entry is an interval inside [e^-100, 1].
function tables(s) {
  validateFactorSnapshot(s);
  const d=BigInt(s.liquidity);
  return s.factors.map(f=>{
    const values=f.values.map(BigInt),max=values.reduce((a,b)=>a>b?a:b,0n);
    return {members:claimEvents(f.scope),values:values.map(v=>weight(max-v,d))};
  });
}
const slot=(members,yes)=>members.reduce((at,event,i)=>at|(yes.get(event)?1<<i:0),0);
// Sum of the product of every table over all outcomes consistent with `evidence` (event -> boolean).
// Events are eliminated in the pool's order; no joined table ever names more than three events.
function mass(s,tabs,evidence) {
  let pending=tabs;
  for(const event of s.order){
    const bucket=pending.filter(t=>t.members.includes(event)),rest=pending.filter(t=>!t.members.includes(event));
    const joined=[...new Set([event,...bucket.flatMap(t=>t.members)])].sort((x,y)=>x-y);
    const remaining=joined.filter(member=>member!==event);
    const out=Array.from({length:2**remaining.length},()=>[0n,0n]);
    for(let local=0;local<2**joined.length;local++){
      const yes=new Map(joined.map((member,i)=>[member,Boolean(local>>i&1)]));
      if(evidence.has(event)&&evidence.get(event)!==yes.get(event))continue;
      let value=[S,S];
      for(const t of bucket)value=product(value,t.values[slot(t.members,yes)]);
      const at=slot(remaining,yes);
      out[at]=sum([out[at],value]);
    }
    pending=[...rest,{members:remaining,values:out}];
  }
  return pending.reduce((all,t)=>product(all,t.values[0]),[S,S]);
}
const evidenceOf=legs=>new Map(legs);
export function certifiedPair(s) {
  validatePairSnapshot(s);
  const tabs=tables(s),m=legs=>mass(s,tabs,evidenceOf(legs));
  const total=m([]),wa=m([[s.a,true]]),wb=m([[s.b,true]]),wnb=m([[s.b,false]]);
  const wab=m([[s.a,true],[s.b,true]]),wanb=m([[s.a,true],[s.b,false]]);
  const a=ratio(wa,total),b=ratio(wb,total),nb=ratio(wnb,total),joint=ratio(wab,total),independent=product(a,b);
  // Cutoff is a display policy, not a statement that a rare event is impossible.
  const intervals={a,b,joint,givenYes:b[0]>=S/1_000_000_000n?ratio(wab,wb):null,givenNo:nb[0]>=S/1_000_000_000n?ratio(wanb,wnb):null,
    independent,difference:[joint[0]-independent[1],joint[1]-independent[0]]};
  const values={},reasons={};
  for(const [key,bounds] of Object.entries(intervals)){
    values[key]=display(bounds);
    if(values[key]===null)reasons[key]=bounds?'rounding_uncertain':'rare_condition';
  }
  return {values,reasons};
}
// Sum the chosen truth-table states, using the same outward-rounded weights.
// Independence is the product distribution of the selected event marginals.
// Never derive these values from already rounded pair probabilities or buy quotes.
export function certifiedClaim(s,scope,mask) {
  const selected=validateClaim(scope,mask,s.events);
  const tabs=tables(s),m=legs=>mass(s,tabs,evidenceOf(legs)),total=m([]);
  const probabilities=selected.map(event=>[false,true].map(yes=>ratio(m([[event,yes]]),total)));
  let market=[0n,0n],independent=[0n,0n];
  for(let state=0;state<2**selected.length;state++)if(BigInt(mask)&(1n<<BigInt(state))){
    market=sum([market,m(selected.map((event,i)=>[event,Boolean(state&(1<<i))]))]);
    independent=sum([independent,selected.reduce((p,_,i)=>product(p,probabilities[i][Number(Boolean(state&(1<<i)))]),[S,S])]);
  }
  market=ratio(market,total);
  const bounds={market,independent,difference:[market[0]-independent[1],market[1]-independent[0]]};
  const values={},reasons={};
  for(const [key,interval] of Object.entries(bounds)){
    values[key]=display(interval);
    if(values[key]===null)reasons[key]='rounding_uncertain';
  }
  return {values,reasons};
}
function validateAssumptions(s,given) {
  validateFactorSnapshot(s);
  if(!Array.isArray(given)||given.length<1||given.length>3||given.some(g=>!Number.isInteger(g?.event)||g.event<0||g.event>=s.events||typeof g.yes!=='boolean')
    ||new Set(given.map(g=>g.event)).size!==given.length)throw new Error('Invalid assumptions');
  return given;
}
// Chance of each assumption set, and of every question with and without it. `givenYes` is a conditional chance,
// so it is withheld when the assumptions are too unlikely to condition on.
export function certifiedScenario(s,given) {
  validateAssumptions(s,given);
  const tabs=tables(s),m=legs=>mass(s,tabs,evidenceOf(legs)),total=m([]);
  const legs=given.map(g=>[g.event,g.yes]),all=m(legs),chance=ratio(all,total);
  const usable=chance[0]>=S/1_000_000_000n;
  const values={given:display(chance)},reasons={};
  if(values.given===null)reasons.given='rounding_uncertain';
  if(!usable)reasons.givenYes='rare_condition';
  const questions=[];
  for(let event=0;event<s.events;event++){
    const leg=given.find(g=>g.event===event),yes=display(ratio(m([[event,true]]),total));
    const givenYes=!usable?null:leg?(leg.yes?1000:0):display(ratio(m([...legs,[event,true]]),all));
    if(usable&&givenYes===null||yes===null)(reasons.questions??={})[event]='rounding_uncertain';
    questions.push({event,yes,givenYes,assumed:Boolean(leg)});
  }
  return {values,questions,reasons};
}
// Every outcome of a claim's events, in the claim's own bit order (ascending event index).
export function certifiedCells(s,scope) {
  validateFactorSnapshot(s);
  const events=claimEvents(scope);
  if(events.length>3||scope>=2**s.events)throw new Error('Invalid claim');
  const tabs=tables(s),total=mass(s,tabs,new Map());
  return Array.from({length:2**events.length},(_,state)=>({state,
    chance:display(ratio(mass(s,tabs,evidenceOf(events.map((event,i)=>[event,Boolean(state>>i&1)]))),total))}));
}
export function pairInput(s){validatePairSnapshot(s);return [1,s.events,s.a,s.b,s.liquidity,...s.order,s.factors.length,...s.factors.flatMap(f=>[f.scope,...f.values])].join(' ');}
export function scenarioInput(s,given){
  validateAssumptions(s,given);
  return [2,s.events,s.liquidity,...s.order,s.factors.length,...s.factors.flatMap(f=>[f.scope,...f.values]),given.length,...given.flatMap(g=>[g.event,g.yes?1:0])].join(' ');
}
