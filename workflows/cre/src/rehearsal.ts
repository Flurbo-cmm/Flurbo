import type { EventDraft } from './event-draft';

export const REHEARSAL_TITLE='Public rehearsal: scripted settlement checks';
export function rehearsalEvent(bit:number,startsAt:number,endsAt:number):EventDraft['events'][number] {
  if(![0,1,2,3].includes(bit))throw new Error('Unknown rehearsal event');
  return {id:`rehearsal-${bit}`,question:['Will the night market open?', 'Will the concert sell out?', 'Will it rain on Saturday?', 'Will the new cafe open?'][bit],
    yesRule:'YES only when the committed scripted fixture specifies YES. This is not a real-world event.',
    noRule:'NO only when the committed scripted fixture specifies NO. Missing fixture evidence must not become NO.',
    observationStartsAt:startsAt,observationEndsAt:endsAt,
    source:{publisher:'Flurbo test operator',referenceUrl:'https://flurbo.singu.online/rehearsal-rules',recordId:`flurbo-rehearsal.v1:${bit}`,
      selectionRule:bit===0?'Scripted fixture A is YES. Exercise an unchallenged assertion.':bit===1?'Scripted fixture B is NO. Intentionally assert YES, challenge with NO, then have two reviewers vote NO.':bit===3?'Scripted fixture D is YES. Exercise an unchallenged assertion.':'Scripted fixture C has no result. Submit no assertion; finalize VOID after the assertion deadline.',
      finalityRule:'Public testnet rehearsal only. Contract assertion, challenge and voting deadlines apply. No external oracle or CRE report authenticates this fixture.',
      revisionRule:'These scripted records are immutable. Do not replace a fixture result or apply it to any real-event pool.'}};
}
export function validateRehearsalDraft(draft:EventDraft) {
  if(draft.title!==REHEARSAL_TITLE||!draft.clusterId.startsWith('public-rehearsal-')||draft.events.length!==4)throw new Error('Explicit four-event rehearsal required');
  for(const [bit,event] of draft.events.entries()){
    const expected=rehearsalEvent(bit,event.observationStartsAt,event.observationEndsAt);
    for(const key of ['id','question','yesRule','noRule'] as const)if(event[key]!==expected[key])throw new Error('Rehearsal rule changed');
    for(const key of Object.keys(expected.source) as (keyof typeof expected.source)[])if(event.source[key]!==expected.source[key])throw new Error('Rehearsal source changed');
  }
}
