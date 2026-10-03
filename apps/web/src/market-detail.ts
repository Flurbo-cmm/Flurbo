import type {PilotState,PilotNamespace} from './pilot';
export const marketHref=(namespace:PilotNamespace,event:number,yes=true)=>`/markets/${namespace}/${event}${yes?'':'?answer=no'}`;
export function settlementView(state:PilotState,event:number){
  const c=state.cases[event],p=state.manifest.publication,time=state.snapshot.timestamp;
  const end=p.draft.events[event].observationEndsAt;
  const lastEnd=Math.max(...p.draft.events.map(e=>e.observationEndsAt));
  const outcomes=['Pending','No','Yes','Void'];
  // The resolver accepts no assertion after this deadline, so an unasserted event can only finalize as Void.
  const lapsed=!state.delivered&&c.phase===0&&time>=Number(c.assertionDeadline);
  const title=state.delivered?'Settled':c.phase===3?'Result confirmed':c.phase===2?'Result disputed':c.phase===1?`Proposed ${outcomes[c.proposal]}`:lapsed?'Settling as void':time<p.draft.closesAt?'Open for predictions':time<end?'Waiting for the event':'Resolving';
  return {title,lapsed,result:outcomes[c.result],closes:p.draft.closesAt,observes:end,
    // This question's own result; payouts still wait for every question in the pool (fallbackAfter, delivered).
    expectedFrom:end+p.challengePeriod,payoutsFrom:lastEnd+p.challengePeriod,
    deadline:c.phase===1?Number(c.challengeUntil):c.phase===2?Number(c.voteUntil):Number(c.assertionDeadline),
    fallbackAfter:lastEnd+p.assertionPeriod+p.challengePeriod+p.votingPeriod,
    description:state.delivered?'The shared pool is settled. Winning and void-adjusted shares can be collected.':c.phase===3?'This result is confirmed. Payouts become available when the connected group settles.':c.phase===2?'A challenge is being resolved. You do not need to approve the result.':c.phase===1?'The proposed answer is open to challenges before it becomes final.':lapsed?'No answer was proposed before the deadline, so this result will be void. A void result pays half for each Yes or No share in this market, and combinations are adjusted the same way. Payouts open after the shared pool is settled on-chain.':time<end?'Your shares stay in your wallet while the event runs.':'The result is pending. Your shares stay in your wallet; you do not need to place another trade.'};
}
