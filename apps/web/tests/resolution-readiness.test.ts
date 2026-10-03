import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolutionReadiness} from '../server/resolution-readiness.mjs';
import {activityEvent} from '../shared/ethereum-activity.mjs';
import {settlementEvent,settlementBindings,pilotRulesHash} from '../server/settlement-publication.mjs';
const owner='0x'+'ab'.repeat(20),pool='0x'+'cd'.repeat(20),rulesHash='0x'+'ef'.repeat(32),close=1800000000;
function input(){
  const manifest={pool,rulesHash,publication:{creator:'0x'+'11'.repeat(20),reviewers:[{address:'0x'+'22'.repeat(20)}],mode:'ethereum-activity',bondAtoms:'1000000',
    draft:{title:'Test',clusterId:`ethereum-test-v1-${close}`,closesAt:close,events:['fullness','transactions'].map(m=>activityEvent(m,close+120))}}};
  return {manifest,state:{delivered:false,poolCash:'10000000',requiredCollateral:'10000000',cases:[0,1].map(()=>({phase:0,assertionDeadline:close+5520}))},
    env:{FLURBO_MONITOR_ENABLED:'true',FLURBO_RESOLUTION_ENABLED:'true',FLURBO_RESOLUTION_EXECUTE:'true',FLURBO_RESOLUTION_PROPOSALS:'true',FLURBO_RESOLUTION_POOL:pool,FLURBO_RESOLUTION_RULES_HASH:rulesHash,FLURBO_RESOLUTION_SIGNER_ADDRESS:owner},
    inspection:{monitors:[{pool,identityMatches:true,status:'observed',ageSeconds:10,queued:0}],anyPending:false,signerLease:{held:false}},
    registered:[manifest],monitored:[manifest],gasWei:100n,gasBudgetWei:50n,cashAtoms:2000000n,holdingsClear:true,pendingNonce:2,latestNonce:2,now:close-10};
}
test('ready configuration never claims scheduler or end-to-end settlement proof',()=>{
  const report=resolutionReadiness(input());assert.equal(report.status,'configuration_ready');
  assert.equal(report.schedulerVerified,false);assert.equal(report.unattendedSettlementVerified,false);
});
test('registration, finish-only pools, disabled proposals and monitor failures block readiness',()=>{
  const cases=[['WEBSITE_NOT_REGISTERED',(v:any)=>v.registered=[]],['MONITOR_NOT_REGISTERED',(v:any)=>v.monitored=[]],
    ['NOT_PROPOSAL_POOL',(v:any)=>v.env.FLURBO_RESOLUTION_POOL=owner],['DISABLED_FLURBO_RESOLUTION_PROPOSALS',(v:any)=>v.env.FLURBO_RESOLUTION_PROPOSALS='false'],
    ['MONITOR_UNHEALTHY',(v:any)=>v.inspection.monitors[0].ageSeconds=901],['MONITOR_UNHEALTHY',(v:any)=>v.inspection.monitors[0].ageSeconds=undefined],['MONITOR_UNHEALTHY',(v:any)=>v.inspection.monitors[0].queued=1],
    ['PENDING_TRANSACTION',(v:any)=>v.inspection.anyPending=true],['BOND_FUNDS_LOW',(v:any)=>v.cashAtoms=1999999n],
    ['GAS_FUNDS_LOW',(v:any)=>v.gasWei=49n],['HOLDINGS_UNVERIFIED',(v:any)=>v.holdingsClear=false],
    ['UNTRACKED_TRANSACTION',(v:any)=>v.pendingNonce=3],['NONCE_UNVERIFIED',(v:any)=>v.pendingNonce=undefined],
    ['FINISHING_CONFIGURATION_INVALID',(v:any)=>v.env.FLURBO_RESOLUTION_FINISH_ALLOWLIST='invalid'],
    ['ASSERTION_DEADLINE_MISSED',(v:any)=>v.now=close+5520]] as const;
  for(const [code,mutate] of cases){const v=input();mutate(v);const r=resolutionReadiness(v);assert.equal(r.status,'blocked');assert.ok(r.issues.some((i:any)=>i.code===code),code);}
});
test('manual assertions block unattended readiness and disputes remain visible',()=>{
  const v:any=input();v.state.cases=[{phase:1,challengeUntil:close-20,assertionDeadline:close+5520},{phase:2,assertionDeadline:close+5520}];
  const r=resolutionReadiness(v);assert.equal(r.warnings.length,1);assert.ok(r.issues.some((i:any)=>i.code==='ASSERTION_NOT_OWNED'));
  v.state.cases[0]={...v.state.cases[0],asserter:owner,evidenceHash:'0xabc',proposal:2};
  v.inspection.journal={pools:[{pool,owned:{0:{evidenceHash:'0xabc',outcome:2}}}]};
  const owned=resolutionReadiness(v);assert.equal(owned.warnings.length,2);assert.ok(!owned.issues.some((i:any)=>i.code==='ASSERTION_NOT_OWNED'));
});

test('general-source readiness validates immutable rules and explicit public evidence configuration',()=>{
  const v:any=input();
  const rules=[0,1].map(i=>({schema:'flurbo.settlement-rule.v1',eventId:`record-${i}`,question:`Is record ${i} above four?`,
    source:{id:`source-${i}`,publisher:'Fixture source',adapter:'json-record.v1',urls:[`https://data.example.org/${i}.json`],
      fields:Object.fromEntries(['id','series','period','unit','publishedAt','kind','value'].map(k=>[k,`/${k}`]))},
    observation:{series:`series-${i}`,period:'2026-01',unit:'count'},decision:{type:'number',operator:'gt',value:'4'},
    timing:{scheduledAt:close+60,publicationCutoff:close+120,correctionCutoff:close+120,observationEndsAt:close+120,assertionPeriod:3600,challengePeriod:3600,votingPeriod:3600},
    vintage:'initial',missingPolicy:'resolver-timeout-void'}));
  const publication={...v.manifest.publication,schema:'flurbo.pilot-publication.v1',mode:'deterministic-source-v1',rulesReviewed:true,
    reviewers:[1,2,3].map(i=>({address:'0x'+String(i).repeat(40)})),assertionPeriod:3600,challengePeriod:3600,votingPeriod:3600,settlementRules:rules,
    draft:{schema:'flurbo.event-draft.v1',status:'draft',chainId:10143,clusterId:'general-readiness',title:'General readiness',closesAt:close,
      events:rules.map(settlementEvent),exceptionPolicy:'Fixed void policy',disputeModel:'reviewer-panel',disputePolicy:'Fixture reviewers'}};
  const bindings=settlementBindings(publication),resolver='0x'+'55'.repeat(20);
  const manifest={schema:'flurbo.pilot-manifest.v1',status:'verified_pilot_snapshot',chainId:10143,pool,resolver,publication,
    draftHash:bindings.draftHash,configHash:bindings.configHash,rulesHash:pilotRulesHash(bindings.config,resolver,publication.creator)};
  v.manifest=manifest;v.registered=[manifest];v.monitored=[manifest];v.env.FLURBO_RESOLUTION_RULES_HASH=manifest.rulesHash;
  let r=resolutionReadiness(v);assert.ok(r.issues.some((i:any)=>i.code==='SOURCE_MODE_DISABLED'));assert.ok(r.issues.some((i:any)=>i.code==='PUBLIC_EVIDENCE_ORIGIN_MISSING'));
  v.env.FLURBO_RESOLUTION_SOURCE_MODE='deterministic-source-v1';v.env.FLURBO_RESOLUTION_EVIDENCE_ORIGIN='https://evidence.flurbo.dev';
  r=resolutionReadiness(v);assert.equal(r.status,'configuration_ready');assert.equal(r.unattendedSettlementVerified,false);
  publication.settlementRules[0].decision.value='5';
  assert.ok(resolutionReadiness(v).issues.some((i:any)=>i.code==='UNSUPPORTED_EVIDENCE'));
});
