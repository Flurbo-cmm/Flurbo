import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assessSemantics,semanticRegistry,semanticConfig,semanticDiagnostics} from '../server/semantic-validation.mjs';
import {encodeClaim} from '../shared/claims.mjs';
const pool='0x'+'1'.repeat(40),rulesHash='0x'+'2'.repeat(64);
const manifest={pool,rulesHash,publication:{draft:{events:[{},{}]}}};
const predicate=(event:number,operator:string,value:string,observation='eth:close:usd:2027-01-01')=>({event,operator,value,observation,sourceRule:'Exact closing observation, integer USD cents, same source and timestamp.'});
const registry=(predicates:any[])=>semanticRegistry(JSON.stringify({schema:'flurbo.semantic-rules.v1',markets:[{pool,rulesHash,predicates}]}));
const exclusive=registry([predicate(0,'gte','300000'),predicate(1,'lt','250000')]);
const input={scope:3,mask:'8',quantityAtoms:'1000000'};

test('exclusive AND has no ordinary payout, while VOID is not falsely described as zero',()=>{
  const r=assessSemantics(manifest,input,exclusive,1000);
  assert.equal(r.status,'collision');assert.equal(r.code,'SEMANTIC_COLLISION');
  assert.deepEqual(r.matrix.map(s=>s.admissible),[true,true,true,false]);
  assert.equal(r.ordinaryMaximumPayoutAtoms,'0');assert.equal(r.maximumVoidPayoutAtoms,'500000');
  assert.equal(r.expiresAt,1060);
});
test('OR and exactly one remain possible; inverse answers use the actual claim mask',()=>{
  for(const rule of ['OR','EXACTLY_ONE']){
    const {scope,mask}=encodeClaim({events:2,legs:[{event:0,yes:true},{event:1,yes:true}],rule});
    assert.equal(assessSemantics(manifest,{...input,scope,mask},exclusive).status,'no_declared_collision');
  }
  assert.equal(assessSemantics(manifest,{...input,mask:'2'},exclusive).status,'no_declared_collision');
});
test('same asset with different observation windows is never inferred exclusive from a title',()=>{
  const separate=registry([predicate(0,'gte','300000','eth:intraday-max'),predicate(1,'lt','250000','eth:close')]);
  assert.equal(assessSemantics(manifest,input,separate).matrix[3].admissible,true);
  const unknown=assessSemantics(manifest,input,semanticRegistry(''));assert.equal(unknown.status,'unknown');assert.ok(unknown.matrix.every(s=>s.admissible));
});
test('integer boundary truth is exact, including negative thresholds and equality',()=>{
  for(const [a,b,value,collision] of [['gte','lte','0',false],['gt','lte','0',true],['eq','lt','-10',true],['eq','gte','-10',false]] as const){
    assert.equal(assessSemantics(manifest,input,registry([predicate(0,a,value),predicate(1,b,value)])).status==='collision',collision);
  }
});
test('client constraints, invalid scope, numeric amounts and mismatched rule bindings are refused',()=>{
  for(const change of [{predicates:[]},{quantityAtoms:1000000},{scope:4},{mask:'15'},{quantityAtoms:'0'}])assert.throws(()=>assessSemantics(manifest,{...input,...change},exclusive),{status:400});
  assert.throws(()=>assessSemantics({...manifest,rulesHash:'0x'+'3'.repeat(64)},input,exclusive),/match/);
  assert.throws(()=>registry([predicate(0,'approx','1')]),/predicate/);
  assert.throws(()=>registry([predicate(0,'lt','1'),predicate(0,'gt','2')]),/predicate/);
});
test('constraints outside selected scope are projected through the full pool',()=>{
  const three={...manifest,publication:{draft:{events:[{},{},{}]}}};
  const rules=registry([predicate(0,'gte','100'),predicate(1,'gte','200'),predicate(2,'gte','300')]);
  // A No AND C Yes is impossible, even with B unselected.
  assert.equal(assessSemantics(three,{...input,scope:5,mask:'4'},rules).status,'collision');
});

const rules=(markets:any[])=>JSON.stringify({schema:'flurbo.semantic-rules.v1',markets});
const exclusiveRules=rules([{pool,rulesHash,predicates:[predicate(0,'gte','300000'),predicate(1,'lt','250000')]}]);
test('the switch defaults to off, never reads rules while off, and rejects unknown modes',()=>{
  for(const mode of [undefined,'','off']){
    const config=semanticConfig({mode,rules:'not json'});
    assert.equal(config.mode,'disabled');
    const r:any=assessSemantics(manifest,input,config,1000);
    assert.deepEqual(Object.keys(r).sort(),['checkedAt','configRevision','expiresAt','mask','mode','notice','pool','quantityAtoms','rulesHash','schema','scope']);
    assert.equal(r.mode,'disabled');assert.equal(r.expiresAt,1060);assert.match(r.notice,/not been checked/);
  }
  // Claim binding still applies while off.
  assert.throws(()=>assessSemantics(manifest,{...input,scope:4},semanticConfig({mode:'off'})),{status:400});
  for(const mode of ['on','true','ENFORCE','warn'])assert.throws(()=>semanticConfig({mode,rules:''}),/must be/);
});
test('enforce mode validates at startup: unreadable configuration fails, a bad entry only affects its own pool',()=>{
  assert.throws(()=>semanticConfig({mode:'enforce',rules:'{'}),/not JSON/);
  assert.throws(()=>semanticConfig({mode:'enforce',rules:JSON.stringify({schema:'other',markets:[]})}),/Invalid semantic rules/);
  assert.throws(()=>semanticConfig({mode:'enforce',rules:rules([{pool:'0xABC',rulesHash,predicates:[]}])}),/pool/);
  const other='0x'+'5'.repeat(40);
  const config=semanticConfig({mode:'enforce',rules:rules([{pool,rulesHash,predicates:[predicate(0,'approx','1')]},{pool:other,rulesHash,predicates:[predicate(0,'gte','1')]}])});
  assert.throws(()=>assessSemantics(manifest,input,config),/misconfigured/);
  assert.equal(assessSemantics({...manifest,pool:other},{...input,mask:'1'},config).status,'unknown');
  const duplicate=semanticConfig({mode:'enforce',rules:rules([{pool,rulesHash,predicates:[]},{pool,rulesHash,predicates:[]}])});
  assert.throws(()=>assessSemantics(manifest,input,duplicate),/misconfigured/);
});
test('configuration revision changes with mode and rules, and enforced answers carry it',()=>{
  const off=semanticConfig({mode:'off',rules:exclusiveRules}),empty=semanticConfig({mode:'enforce',rules:''}),on=semanticConfig({mode:'enforce',rules:exclusiveRules});
  assert.equal(off.revision,semanticConfig({mode:'off',rules:''}).revision,'unused rules do not change the disabled revision');
  assert.equal(new Set([off.revision,empty.revision,on.revision]).size,3);
  const r:any=assessSemantics(manifest,input,on);assert.equal(r.mode,'enforced');assert.equal(r.configRevision,on.revision);assert.equal(r.status,'collision');
});
test('operator diagnostics report mode, revision, coverage and misconfiguration per market',()=>{
  const three={...manifest,pool:'0x'+'6'.repeat(40),publication:{draft:{events:[{},{},{}]}}};
  const stale={...manifest,pool:'0x'+'7'.repeat(40)};
  const config=semanticConfig({mode:'enforce',rules:rules([{pool,rulesHash,predicates:[predicate(0,'gte','1'),predicate(1,'lt','1')]},
    {pool:three.pool,rulesHash,predicates:[predicate(0,'gte','1')]},{pool:stale.pool,rulesHash:'0x'+'9'.repeat(64),predicates:[]},{pool:'0x'+'8'.repeat(40),rulesHash,predicates:[]}])});
  const d=semanticDiagnostics(config,[{namespace:'pilot',manifest},{namespace:'three',manifest:three},{namespace:'stale',manifest:stale},{namespace:'bare',manifest:{...manifest,pool:'0x'+'a'.repeat(40)}}]);
  assert.equal(d.mode,'enforced');assert.equal(d.configRevision,config.revision);
  assert.deepEqual(d.markets.map((m:any)=>m.status),['mapped','partial','misconfigured','unmapped']);
  assert.match(d.markets[2].error,/match/);assert.deepEqual(d.unusedRules,['0x'+'8'.repeat(40)]);
  assert.deepEqual(semanticDiagnostics(semanticConfig({mode:'off'}),[{namespace:'pilot',manifest}]).markets.map((m:any)=>m.status),['disabled']);
});
