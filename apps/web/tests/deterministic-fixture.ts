import { settlementEvent, settlementBindings, pilotRulesHash } from '../server/settlement-publication.mjs';
import { pilotFixture } from './pilot-fixture.ts';

// Static manifest fixture only. Its code hashes are mock values, never deployment proof.
export function deterministicManifest() {
  const manifest = structuredClone(pilotFixture().manifest), p = manifest.publication;
  p.schema = 'flurbo.pilot-publication.v1'; p.mode = 'deterministic-source-v1'; p.rulesReviewed = true;
  Object.assign(p.draft, {schema: 'flurbo.event-draft.v1', status: 'draft', chainId: 10143, clusterId: 'source-fixture', disputeModel: 'reviewer-panel'});
  p.settlementRules = p.draft.events.map((event: any, bit: number) => ({schema: 'flurbo.settlement-rule.v1', eventId: event.id, question: event.question,
    source: {id: `source-${bit}`, publisher: 'Fixture publisher', urls: [`https://data.example.org/record-${bit}.json`], adapter: 'json-record.v1',
      fields: {id: '/id', series: '/series', period: '/period', unit: '/unit', publishedAt: '/publishedAt', kind: '/kind', value: '/value'}},
    observation: {series: `series-${bit}`, period: '2026-09', unit: 'percent'}, decision: {type: 'number', operator: 'gt', value: '4.2'},
    timing: {scheduledAt: event.observationStartsAt, publicationCutoff: event.observationEndsAt, correctionCutoff: event.observationEndsAt,
      observationEndsAt: event.observationEndsAt, assertionPeriod: p.assertionPeriod, challengePeriod: p.challengePeriod, votingPeriod: p.votingPeriod},
    vintage: 'initial', missingPolicy: 'resolver-timeout-void'}));
  p.draft.events = p.settlementRules.map(settlementEvent);
  const bindings = settlementBindings(p);
  manifest.draftHash = bindings.draftHash; manifest.configHash = bindings.configHash;
  manifest.rulesHash = pilotRulesHash(bindings.config, manifest.resolver, p.creator);
  return manifest;
}
