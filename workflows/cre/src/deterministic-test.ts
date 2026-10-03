import { preparePilot, disputePolicy, VOID_POLICY } from './pilot-config';
import { settlementEvent, SNAPSHOT_SETTLE_SECONDS } from '../../../apps/web/server/settlement-publication.mjs';

// This rehearsal measures a publisher's bounded catalogue snapshot, not the final
// physical earthquake count. Its immutable windows start only on explicit preparation. The snapshot opens
// SNAPSHOT_SETTLE_SECONDS (3 hours) after each interval so late catalogue additions are included.
export function prepareDeterministicTest(selection: {creator: string; reviewers: {name: string; address: string}[]}, now: number,
  closesAt = Math.ceil(now / 60) * 60 + 90 * 60) {
  const policy = { creator: selection.creator, reviewers: selection.reviewers, reviewerControl: 'single-operator' as const,
    independentReviewersConfirmed: false, rulesReviewed: true, bondAtoms: '1000000', assertionPeriod: 3600, challengePeriod: 3600, votingPeriod: 3600 };
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');
  const settlementRules = [0, 1].map(bit => {
    const start = closesAt + 120 + bit * 360, end = start + 300;
    const scheduledAt = end + SNAPSHOT_SETTLE_SECONDS, publicationCutoff = scheduledAt + 300;
    const period = `${iso(start)}/${iso(end)}`, url = new URL('https://earthquake.usgs.gov/fdsnws/event/1/query');
    for (const [key, value] of Object.entries({format: 'geojson', starttime: iso(start), endtime: iso(end), eventtype: 'earthquake', orderby: 'time-asc'})) url.searchParams.set(key, value);
    const condition = bit === 0 ? 'at least one earthquake' : 'zero earthquakes';
    return { schema: 'flurbo.settlement-rule.v1', eventId: `usgs-window-${bit + 1}`,
      question: `Will the first retained USGS catalogue snapshot generated and captured between ${iso(scheduledAt)} and ${iso(publicationCutoff)} report ${condition} with origin time from ${iso(start)} through ${iso(end)}?`,
      source: {id: `usgs-catalogue-${bit + 1}`, publisher: 'United States Geological Survey', urls: [url.href], adapter: 'usgs-earthquake-count.v1'},
      observation: {series: 'catalogue-event-count', period, unit: 'events'},
      decision: {type: 'number', operator: bit === 0 ? 'gte' : 'eq', value: bit === 0 ? '1' : '0'},
      timing: {scheduledAt, publicationCutoff, correctionCutoff: publicationCutoff, observationEndsAt: publicationCutoff,
        assertionPeriod: 3600, challengePeriod: 3600, votingPeriod: 3600},
      vintage: 'first-observed-snapshot', missingPolicy: 'resolver-timeout-void' };
  });
  return preparePilot({schema: 'flurbo.pilot-publication.v1', mode: 'deterministic-source-v1', ...policy, settlementRules,
    draft: {schema: 'flurbo.event-draft.v1', status: 'draft', chainId: 10143, clusterId: `usgs-test-v1-${closesAt}`,
      title: 'Test: official-source settlement', closesAt, events: settlementRules.map(settlementEvent),
      exceptionPolicy: VOID_POLICY, disputeModel: 'reviewer-panel', disputePolicy: disputePolicy(policy)}}, now);
}
