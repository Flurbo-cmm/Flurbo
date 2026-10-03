import { preparePilot,disputePolicy,VOID_POLICY } from './pilot-config';
import { rehearsalEvent,REHEARSAL_TITLE } from './rehearsal';

// Approved September 25, 2026. This config changes dates only, not settlement rules.
export const OCTOBER_CLOSE=Math.floor(Date.parse('2026-10-14T12:00:00Z')/1000);
export function prepareOctoberDemo(selection:{creator:string;reviewers:{name:string;address:string}[]},now:number){
  const policy={creator:selection.creator,reviewers:selection.reviewers,reviewerControl:'single-operator' as const,independentReviewersConfirmed:false,rulesReviewed:true,
    bondAtoms:'1000000',assertionPeriod:3600,challengePeriod:3600,votingPeriod:3600};
  return preparePilot({schema:'flurbo.pilot-publication.v1',mode:'rehearsal',...policy,
    draft:{schema:'flurbo.event-draft.v1',status:'draft',chainId:10143,clusterId:'public-rehearsal-october-2026',title:REHEARSAL_TITLE,closesAt:OCTOBER_CLOSE,
      events:[0,1,2,3].map(bit=>rehearsalEvent(bit,OCTOBER_CLOSE+60,OCTOBER_CLOSE+120)),disputeModel:'reviewer-panel',disputePolicy:disputePolicy(policy),exceptionPolicy:VOID_POLICY}},now);
}
