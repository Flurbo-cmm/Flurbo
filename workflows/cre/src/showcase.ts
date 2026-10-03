import {preparePilot,disputePolicy,VOID_POLICY} from './pilot-config';
import {activityEvent,ACTIVITY_METRICS,TEST_ACTIVITY_METRICS,ACTIVITY_MODE,ACTIVITY_TITLE} from '../../../apps/web/shared/ethereum-activity.mjs';
export function prepareShowcase(selection:{creator:string;reviewers:{name:string;address:string}[]},now:number,closesAt=Math.ceil(now/60)*60+4*3600){
  const policy={creator:selection.creator,reviewers:selection.reviewers,reviewerControl:'single-operator' as const,independentReviewersConfirmed:false,rulesReviewed:true,
    bondAtoms:'1000000',assertionPeriod:3600,challengePeriod:3600,votingPeriod:3600};
  return preparePilot({schema:'flurbo.pilot-publication.v1',mode:ACTIVITY_MODE,...policy,
    draft:{schema:'flurbo.event-draft.v1',status:'draft',chainId:10143,clusterId:`showcase-v0-${closesAt}`,title:ACTIVITY_TITLE,closesAt,
      events:ACTIVITY_METRICS.map(metric=>activityEvent(metric,closesAt+120)),disputeModel:'reviewer-panel',disputePolicy:disputePolicy(policy),exceptionPolicy:VOID_POLICY}},now);
}

export function prepareActivityTest(selection:{creator:string;reviewers:{name:string;address:string}[]},now:number,closesAt=Math.ceil(now/60)*60+90*60){
  const policy={creator:selection.creator,reviewers:selection.reviewers,reviewerControl:'single-operator' as const,independentReviewersConfirmed:false,rulesReviewed:true,
    bondAtoms:'1000000',assertionPeriod:3600,challengePeriod:3600,votingPeriod:3600};
  return preparePilot({schema:'flurbo.pilot-publication.v1',mode:ACTIVITY_MODE,...policy,
    draft:{schema:'flurbo.event-draft.v1',status:'draft',chainId:10143,clusterId:`ethereum-test-v1-${closesAt}`,title:'Test',closesAt,
      events:TEST_ACTIVITY_METRICS.map(metric=>activityEvent(metric,closesAt+120)),disputeModel:'reviewer-panel',disputePolicy:disputePolicy(policy),exceptionPolicy:VOID_POLICY}},now);
}
