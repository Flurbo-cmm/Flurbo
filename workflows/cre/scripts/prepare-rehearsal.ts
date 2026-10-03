import { preparePilot,disputePolicy,VOID_POLICY } from '../src/pilot-config';
import { rehearsalEvent,REHEARSAL_TITLE } from '../src/rehearsal';
const root=new URL('../../../',import.meta.url);
const selection=await Bun.file(new URL('config/pilot-alpha-selection.json',root)).json();
const now=Math.floor(Date.now()/1000),closesAt=now+86400;
const policy={creator:selection.creator,reviewers:selection.reviewers,reviewerControl:'single-operator' as const,independentReviewersConfirmed:false,rulesReviewed:true,
  bondAtoms:'1000000',assertionPeriod:3600,challengePeriod:3600,votingPeriod:3600};
const publication={schema:'flurbo.pilot-publication.v1',mode:'rehearsal',...policy,
  draft:{schema:'flurbo.event-draft.v1',status:'draft',chainId:10143,clusterId:`public-rehearsal-${now}`,title:REHEARSAL_TITLE,closesAt,
    events:[0,1,2,3].map(bit=>rehearsalEvent(bit,closesAt+60,closesAt+120)),disputeModel:'reviewer-panel',disputePolicy:disputePolicy(policy),exceptionPolicy:VOID_POLICY}};
const prepared=preparePilot(publication,now);
await Bun.write(new URL('target/deployments/rehearsal-prepared.json',root),JSON.stringify(prepared,null,2)+'\n');
console.log(JSON.stringify({status:prepared.status,mode:'rehearsal',configHash:prepared.configHash,subsidyTestAusd:'27.725888',
  tradeCloses:new Date(closesAt*1000).toISOString(),assertionsOpen:new Date((closesAt+120)*1000).toISOString(),
  assertionDeadline:new Date((closesAt+3720)*1000).toISOString(),notice:'Deploy within twenty-three hours of preparing. Trading stays open for one day from preparation. No deployment has occurred. Do not overwrite the real pilot manifest.'},null,2));
