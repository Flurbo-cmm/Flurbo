import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deterministicEvidence } from '../server/deterministic-evidence.mjs';
import { createSettlementStores, SETTLEMENT_PACKET_PATH } from '../server/settlement-persistence.mjs';
import { createLocalSettlementCommand } from '../server/local-settlement-command.mjs';
import { settlementEvent, settlementBindings, pilotRulesHash, DETERMINISTIC_MODE } from '../server/settlement-publication.mjs';
import { canonical, digest, settlementRuleHash, validateSettlementRule } from '../server/settlement-rules.mjs';
import { evaluateSettlement, parseSettlementCapture } from '../server/settlement-evidence.mjs';
import { pilotEvidence } from '../server/pilot.mjs';
import { runResolution } from '../scripts/run-resolution.mjs';
import { monitorIdentity } from '../server/settlement-monitor.mjs';
import { createHash } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, keccak256, parseTransaction } from 'viem';
import { resolverAbi } from '../shared/pilot.mjs';

const start=1800000000, origin='https://evidence.flurbo.example.org', owner='0x'+'12'.repeat(20);
export function deterministicFixture(rules?:any[]) {
  rules ||= [0,1].map(i=>({schema:'flurbo.settlement-rule.v1',eventId:`general-${i}`,question:`Is observation ${i} above four?`,
    source:{id:`official-${i}`,publisher:'Synthetic official source',adapter:'json-record.v1',urls:[`https://data.example.org/${i}.json`],
      fields:Object.fromEntries(['id','series','period','unit','publishedAt','kind','value'].map(key=>[key,`/${key}`]))},
    observation:{series:`series-${i}`,period:'2026-01',unit:'count'},decision:{type:'number',operator:'gt',value:'4'},
    vintage:'initial',missingPolicy:'resolver-timeout-void',timing:{scheduledAt:start,publicationCutoff:start+120,correctionCutoff:start+120,
      observationEndsAt:start+120,assertionPeriod:3600,challengePeriod:3600,votingPeriod:3600}}));
  const publication:any={schema:'flurbo.pilot-publication.v1',mode:DETERMINISTIC_MODE,rulesReviewed:true,creator:'0x'+'11'.repeat(20),
    bondAtoms:'1000000',assertionPeriod:3600,challengePeriod:3600,votingPeriod:3600,
    reviewers:[6,7,8].map(n=>({name:`Reviewer ${n}`,address:'0x'+String(n).repeat(40)})),settlementRules:rules,
    draft:{schema:'flurbo.event-draft.v1',status:'draft',chainId:10143,clusterId:'synthetic-general-test',title:'Synthetic source tests',closesAt:start-60,
      events:rules.map(settlementEvent),exceptionPolicy:'Unavailable data follows resolver timeout VOID.',disputeModel:'bonded-reviewer-panel',disputePolicy:'Published panel resolves challenges.'}};
  const bindings=settlementBindings(publication),resolver='0x'+'33'.repeat(20);
  return {schema:'flurbo.pilot-manifest.v1',status:'verified_pilot_snapshot',chainId:10143,pool:'0x'+'22'.repeat(20),resolver,
    draftHash:bindings.draftHash,configHash:bindings.configHash,rulesHash:pilotRulesHash(bindings.config,resolver,publication.creator),publication};
}
const state={delivered:false,cases:[{phase:0},{phase:0}]};

test('durable general-source capture precedes observation end; NO evidence survives restart and public readback',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'flurbo-general-'));let at=start+5,unavailable=false,publicWrong=false,value='3';
  try{
    const command=await createLocalSettlementCommand({directory,now:()=>at*1000});
    const stores=createSettlementStores({command,origin,now:()=>at}),archive=pilotEvidence(command,origin,()=>at*1000),manifest=deterministicFixture();
    const request=async(url:string)=>{
      if(url.startsWith('https://data.example.org/')){
        if(unavailable)return new Response('unavailable',{status:503});
        const i=url.includes('/0.')?0:1;
        return Response.json({id:`release-${i}`,series:`series-${i}`,period:'2026-01',unit:'count',publishedAt:start,kind:'initial',value,
          padding:'x'.repeat(15000)}); // Exercises a referenced durable packet, not only inline archive evidence.
      }
      if(publicWrong)return Response.json({wrong:true});
      if(url.startsWith(origin+SETTLEMENT_PACKET_PATH))return new Response(canonical(await stores.packetStore.get(url)),{headers:{'content-type':'application/json'}});
      return new Response(await archive.get(url.split('/').at(-1)),{headers:{'content-type':'application/json'}});
    };
    const make=()=>deterministicEvidence({manifest,owner,command,archive,...stores,origin,request,now:()=>at});
    assert.equal((await make().collect(state))[0].status,'captured');
    assert.equal(await make().proposal(0),null);
    at=start+120;await make().collect(state);
    const proposal=await make().proposal(0);assert.equal(proposal?.outcome,1);
    at++;await make().collect(state);
    assert.deepEqual(await make().proposal(0),proposal); // New factory simulates a worker restart, same frozen archive identity.
    publicWrong=true;await assert.rejects(make().proposal(0),/PUBLIC_EVIDENCE/);publicWrong=false;
    unavailable=true;await make().collect(state);assert.equal(await make().proposal(0),null);
    unavailable=false;await make().collect(state);assert.deepEqual(await make().proposal(0),proposal);
    value='5';await make().collect(state);assert.equal(await make().proposal(0),null); // Conflicting initial observation is not overwritten.
    const changed=structuredClone(manifest);changed.publication.settlementRules[0].decision.value='3';
    assert.throws(()=>deterministicEvidence({manifest:changed,owner,command,archive,...stores,origin,request,now:()=>at}),/committed/);
  }finally{await rm(directory,{recursive:true,force:true});}
});

function usgsRule():any{
  const iso=(n:number)=>new Date(n*1000).toISOString(),begin=start-300,end=start-1;
  const params=new URLSearchParams({format:'geojson',starttime:iso(begin),endtime:iso(end),eventtype:'earthquake',orderby:'time-asc'});
  return {schema:'flurbo.settlement-rule.v1',eventId:'usgs-a',question:'Does the first complete captured catalogue contain at least one earthquake?',
    source:{id:'usgs',publisher:'US Geological Survey',adapter:'usgs-earthquake-count.v1',urls:['https://earthquake.usgs.gov/fdsnws/event/1/query?'+params]},
    observation:{series:'catalogue-event-count',period:iso(begin)+'/'+iso(end),unit:'events'},decision:{type:'number',operator:'gte',value:'1'},
    vintage:'first-observed-snapshot',missingPolicy:'resolver-timeout-void',timing:{scheduledAt:start,publicationCutoff:start+120,correctionCutoff:start+120,
      observationEndsAt:start+120,assertionPeriod:3600,challengePeriod:3600,votingPeriod:3600}};
}
function usgsCapture(rule:any,at:number,count=0){
  const body=JSON.stringify({type:'FeatureCollection',metadata:{generated:at*1000,url:rule.source.urls[0],status:200,count},
    features:Array.from({length:count},(_,i)=>({type:'Feature',id:'quake-'+i,properties:{type:'earthquake',time:(start-100)*1000}}))});
  return {requestedUrl:rule.source.urls[0],finalUrl:rule.source.urls[0],fetchedAt:at,status:200,complete:true,contentType:'application/json',body,bytes:Buffer.byteLength(body),sha256:digest(body)};
}
test('USGS count is a complete first observed snapshot, never an inferred zero or final physical event count',()=>{
  const r=usgsRule(),first=usgsCapture(r,start+1),later=usgsCapture(r,start+50,1);
  assert.equal(evaluateSettlement(r,[first,later],{now:start+120}).outcome,1);
  assert.equal(evaluateSettlement(r,[later,first],{now:start+120}).outcome,1);
  assert.equal(evaluateSettlement(r,[usgsCapture(r,start+121)],{now:start+121}).status,'unresolved');
  assert.equal(evaluateSettlement(r,[],{now:start+120}).status,'unresolved');
  assert.equal(evaluateSettlement(r,[first,usgsCapture(r,start+1,1)],{now:start+120}).reason,'INITIAL_SOURCE_CONFLICT');
  const broken=JSON.parse(later.body);broken.metadata.count=2;
  const body=JSON.stringify(broken);
  assert.throws(()=>parseSettlementCapture(r,{...later,body,bytes:Buffer.byteLength(body),sha256:digest(body)},start+120),/CATALOGUE_INCOMPLETE/);
  for(const extra of ['&limit=1','&offset=1','&format=geojson']){
    const changed=structuredClone(r);changed.source.urls[0]+=extra;assert.throws(()=>validateSettlementRule(changed),/query/);
  }
  const wrong=structuredClone(r);wrong.vintage='initial';assert.throws(()=>validateSettlementRule(wrong),/USGS/);
});

test('USGS collection freezes the first complete valid snapshot and records a missed capture window',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'flurbo-usgs-'));let at=start+1,calls=0;
  try{
    const a=usgsRule(),b=structuredClone(a);b.eventId='usgs-b';b.question='Second synthetic question for fixture';
    const manifest=deterministicFixture([a,b]),command=await createLocalSettlementCommand({directory,now:()=>at*1000});
    const stores=createSettlementStores({command,origin,now:()=>at}),archive=pilotEvidence(command,origin,()=>at*1000);
    const request=async()=>{calls++;return new Response(usgsCapture(a,at).body,{headers:{'content-type':'application/json'}});};
    const make=()=>deterministicEvidence({manifest,owner,command,archive,...stores,origin,request,now:()=>at});
    await make().collect(state);assert.equal(calls,2);
    at=start+120;assert.equal((await make().collect(state))[0].status,'snapshot-retained');assert.equal(calls,2);
    const other=structuredClone(manifest.publication.settlementRules[0]);other.eventId='missing';
    const missed=deterministicFixture([other,b]);at++;
    const collector=deterministicEvidence({manifest:missed,owner,command,archive,...stores,origin,request,now:()=>at});
    assert.deepEqual((await collector.collect(state))[0].issues,['SNAPSHOT_WINDOW_MISSED']);
    assert.equal((await stores.captureStore.latestAttempt(settlementRuleHash(other)))?.ok,false);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('runResolution integrates durable pre-cutoff observation and a publicly verified deterministic NO through the bounded worker',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'flurbo-worker-'));let at=start+5,signed=0;
  const privateKey=('0x'+'12'.repeat(32)) as `0x${string}`,account=privateKeyToAccount(privateKey),signer=account.address.toLowerCase();
  try{
    const manifest:any=deterministicFixture(),command=await createLocalSettlementCommand({directory,now:()=>at*1000});
    const stores=createSettlementStores({command,origin,now:()=>at}),archive=pilotEvidence(command,origin,()=>at*1000);
    const chain:any={manifest,snapshot:{timestamp:at},poolCash:'1000000',requiredCollateral:'0',delivered:false,
      cases:[0,1].map(()=>({phase:0,assertionDeadline:String(start+3720)}))};
    const service={status:async()=>({...chain,snapshot:{timestamp:at}}),prepare:async(input:any)=>({schema:'flurbo.pilot-review.v1',manifest,
      action:input.action,requested:input,expiresAt:at+60,snapshot:{timestamp:at},amountAtoms:'1000000',gasLimit:'100000',gasPrice:'1000000000',
      transaction:{from:signer,to:manifest.resolver,chainId:10143,value:'0',data:encodeFunctionData({abi:resolverAbi,functionName:'assertOutcome',
        args:[input.event,input.outcome,input.evidenceHash,input.evidenceURI]})}})};
    const request=async(url:string)=>{
      if(url.startsWith('https://data.example.org/')){
        const i=url.includes('/0.')?0:1;
        return Response.json({id:`release-${i}`,series:`series-${i}`,period:'2026-01',unit:'count',publishedAt:start,kind:'initial',value:'0'});
      }
      if(url.startsWith(origin+SETTLEMENT_PACKET_PATH))return new Response(canonical(await stores.packetStore.get(url)),{headers:{'content-type':'application/json'}});
      return new Response(await archive.get(url.split('/').at(-1)),{headers:{'content-type':'application/json'}});
    };
    const transport={sign:async(review:any)=>{signed++;assert.equal(review.requested.outcome,1);return account.signTransaction({chainId:10143,type:'legacy',nonce:0,
      to:review.transaction.to,data:review.transaction.data,value:0n,gas:100000n,gasPrice:1000000000n});},
      broadcast:async(raw:any)=>{assert.equal(parseTransaction(raw).to,manifest.resolver);return keccak256(raw);},receipt:async()=>({confirmed:true,success:true})};
    const deps={command,service,archive,settlementStores:stores,request,transport,now:()=>at,
      proposerHoldings:async()=>({clear:true,positions:[],wrapped:[],blockNumber:'1',checkedClaims:2})};
    const env:any={FLURBO_RESOLUTION_MANIFEST_JSON:JSON.stringify(manifest),FLURBO_RESOLUTION_POOL:manifest.pool,FLURBO_RESOLUTION_RULES_HASH:manifest.rulesHash,
      FLURBO_RESOLUTION_SIGNER_ADDRESS:signer,FLURBO_RESOLUTION_PRIVATE_KEY:privateKey,FLURBO_RESOLUTION_PROPOSALS:'true',FLURBO_RESOLUTION_EXECUTE:'false',
      FLURBO_RESOLUTION_SOURCE_MODE:DETERMINISTIC_MODE,FLURBO_RESOLUTION_EVIDENCE_ORIGIN:origin};
    const monitorKey='flurbo:monitor:v1:'+createHash('sha256').update(monitorIdentity(manifest)).digest('hex')+':state';
    await command('SET',monitorKey,JSON.stringify({checkpoint:{identity:monitorIdentity(manifest),checkedAt:at},report:{status:'observed'},queue:[]}));
    const collecting=await runResolution(env,deps);assert.equal(collecting.status,'dry-run');assert.equal(collecting.sourceObservations[0].status,'captured');assert.equal(signed,0);
    at=start+120;env.FLURBO_RESOLUTION_EXECUTE='true';
    const result=await runResolution(env,deps);assert.equal(result.status,'submitted');assert.equal(result.action,'assertOutcome');assert.equal(signed,1);
    assert.equal((await runResolution(env,deps)).status,'confirmed');assert.equal(signed,1);
    const wrong={...env,FLURBO_RESOLUTION_SOURCE_MODE:'legacy'};await assert.rejects(runResolution(wrong,deps));
    const changed=structuredClone(manifest);changed.publication.settlementRules[0].decision.value='0';
    await assert.rejects(runResolution({...env,FLURBO_RESOLUTION_MANIFEST_JSON:JSON.stringify(changed)},deps));
  }finally{await rm(directory,{recursive:true,force:true});}
});
