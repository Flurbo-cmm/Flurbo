import { test,expect } from 'bun:test';
import { preparePilot,VOID_POLICY,disputePolicy } from '../src/pilot-config';
import { rehearsalEvent,REHEARSAL_TITLE } from '../src/rehearsal';
import { releaseTargetForEvent } from '../src/github-release';

test('scripted rehearsal is explicitly committed and cannot masquerade as official release evidence',()=>{
  const now=1790271000;
  const policy={creator:'0x'+'11'.repeat(20),reviewers:[2,3,4].map(i=>({name:'Operator '+i,address:'0x'+String(i).repeat(40)})),reviewerControl:'single-operator',independentReviewersConfirmed:false,rulesReviewed:true,bondAtoms:'1000000',assertionPeriod:3600,challengePeriod:3600,votingPeriod:3600};
  const input:any={schema:'flurbo.pilot-publication.v1',mode:'rehearsal',...policy,draft:{schema:'flurbo.event-draft.v1',status:'draft',chainId:10143,clusterId:'public-rehearsal-1',title:REHEARSAL_TITLE,closesAt:now+7200,
    events:[0,1,2,3].map(i=>rehearsalEvent(i,now+7260,now+7320)),exceptionPolicy:VOID_POLICY,disputeModel:'reviewer-panel',disputePolicy:disputePolicy(policy as any)}};
  const prepared=preparePilot(input,now);expect(prepared.publication.mode).toBe('rehearsal');
  expect(prepared.eventHashes.length).toBe(4);
  expect(()=>preparePilot({...input,mode:'official-releases'},now)).toThrow();
  expect(()=>preparePilot({...input,mode:undefined},now)).toThrow();
  expect(()=>releaseTargetForEvent(input.draft,'rehearsal-0')).toThrow();
  for(const mutate of [(c:any)=>c.draft.title='Real events',(c:any)=>c.draft.events[1].source.selectionRule='Fixture is YES',(c:any)=>c.draft.events.pop(),(c:any)=>c.assertionPeriod=30]){
    const changed=structuredClone(input);mutate(changed);expect(()=>preparePilot(changed,now)).toThrow();
  }
});

test('adding rehearsal support preserves the deployed official configuration commitment',async()=>{
  const manifest=await Bun.file(new URL('../../../config/pilot-testnet.json',import.meta.url)).json();
  const prepared=preparePilot(manifest.publication,manifest.verifiedTimestamp);
  expect(prepared.configHash).toBe(manifest.configHash);
  expect(prepared.draftHash).toBe(manifest.draftHash);
  expect(()=>preparePilot({...manifest.publication,mode:'rehearsal'},manifest.verifiedTimestamp)).toThrow();
});
