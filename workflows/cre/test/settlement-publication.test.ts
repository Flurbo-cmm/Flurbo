import { test, expect } from 'bun:test';
import { preparePilot, disputePolicy, VOID_POLICY, pilotRulesHash, resolverConfigAbi } from '../src/pilot-config';
import { decodeAbiParameters } from 'viem';
import { settlementEvent, settlementBindings, validateSettlementManifest } from '../../../apps/web/server/settlement-publication.mjs';
import { configureCollection, configurePilot } from '../../../apps/web/server/pilot-config.mjs';

const now = 1_800_000_000;
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
function publication(): any {
  const policy = { creator: addr(4), reviewers: [1, 2, 3].map(n => ({name: `Test reviewer ${n}`, address: addr(n)})),
    reviewerControl: 'single-operator', independentReviewersConfirmed: false, rulesReviewed: true,
    bondAtoms: '1000000', assertionPeriod: 3600, challengePeriod: 3600, votingPeriod: 3600 };
  const settlementRules = [0, 1].map(bit => ({ schema: 'flurbo.settlement-rule.v1', eventId: `source-${bit}`, question: `Will fixture observation ${bit} be greater than 4.2?`,
    source: {id: `fixture-${bit}`, publisher: 'Fixture publisher', urls: [`https://data.example.org/record-${bit}.json`], adapter: 'json-record.v1',
      fields: {id: '/id', series: '/series', period: '/period', unit: '/unit', publishedAt: '/publishedAt', kind: '/kind', value: '/value'}},
    observation: {series: `series-${bit}`, period: '2026-09', unit: 'percent'}, decision: {type: 'number', operator: 'gt', value: '4.2'},
    timing: {scheduledAt: now + 8000, publicationCutoff: now + 8300, correctionCutoff: now + 8300, observationEndsAt: now + 8300,
      assertionPeriod: 3600, challengePeriod: 3600, votingPeriod: 3600}, vintage: 'initial', missingPolicy: 'resolver-timeout-void' }));
  return {schema: 'flurbo.pilot-publication.v1', mode: 'deterministic-source-v1', ...policy, settlementRules,
    draft: {schema: 'flurbo.event-draft.v1', status: 'draft', chainId: 10143, clusterId: 'deterministic-test', title: 'Deterministic fixture',
      closesAt: now + 7200, events: settlementRules.map(settlementEvent), exceptionPolicy: VOID_POLICY, disputeModel: 'reviewer-panel', disputePolicy: disputePolicy(policy as any)}};
}
function manifest(): any {
  const p = preparePilot(publication(), now), [config] = decodeAbiParameters(resolverConfigAbi, p.resolverConfig);
  return {schema: 'flurbo.pilot-manifest.v1', status: 'verified_pilot_snapshot', chainId: 10143, pool: addr(5), resolver: addr(6),
    draftHash: p.draftHash, configHash: p.configHash, rulesHash: pilotRulesHash(config, addr(6) as any, p.creator), publication: p.publication,
    codeHashes: {[addr(5)]: '0x' + 'aa'.repeat(32), [addr(6)]: '0x' + 'bb'.repeat(32)}};
}

test('general rules retain existing draft and resolver ABI and commit complete parser/source semantics', () => {
  const input = publication(), p = preparePilot(input, now), bindings = settlementBindings(p.publication);
  expect(bindings.draftHash).toBe(p.draftHash); expect(bindings.resolverConfig).toBe(p.resolverConfig); expect(bindings.configHash).toBe(p.configHash);
  expect(validateSettlementManifest(manifest())).toEqual(input.settlementRules);
  const reordered = structuredClone(input);
  reordered.settlementRules[0].source.fields = Object.fromEntries(Object.entries(input.settlementRules[0].source.fields).reverse());
  expect(preparePilot(reordered, now).draftHash).toBe(p.draftHash);
  for (const change of [(r: any) => {r.decision.operator = 'gte';}, (r: any) => {r.source.fields.value = '/alternate';},
    (r: any) => {r.source.urls[0] = 'https://data.example.org/other.json';}, (r: any) => {r.observation.period = '2026-10';}]) {
    const altered = structuredClone(input); change(altered.settlementRules[0]);
    expect(() => preparePilot(altered, now)).toThrow(/committed draft/);
    altered.draft.events[0] = settlementEvent(altered.settlementRules[0]);
    expect(preparePilot(altered, now).draftHash).not.toBe(p.draftHash);
  }
});

test('manifest cannot alter the rule plus event hash, dates, identity, or resolver binding after deployment', () => {
  for (const change of [(m: any) => {m.publication.settlementRules[0].decision.value = '4.3';},
    (m: any) => {m.publication.settlementRules[0].decision.value = '4.3'; m.publication.draft.events[0] = settlementEvent(m.publication.settlementRules[0]);},
    (m: any) => {m.publication.draft.closesAt--;}, (m: any) => {m.resolver = addr(7);}, (m: any) => {m.publication.creator = addr(8);},
    (m: any) => {m.configHash = '0x' + '00'.repeat(32);}, (m: any) => {m.publication.settlementRules.reverse();},
    (m: any) => {m.publication.draft.events[0].source.selectionRule = 'Use a different source';}]) {
    const m = manifest(); change(m); expect(() => validateSettlementManifest(m)).toThrow();
  }
});

test('publication refuses implicit mode, unsupported adapters, event-count drift and resolver-window mismatch', () => {
  for (const change of [(p: any) => {delete p.mode;}, (p: any) => {delete p.settlementRules;}, (p: any) => {p.settlementRules.pop();},
    (p: any) => {p.settlementRules[0].source.adapter = 'guess-with-ai';}, (p: any) => {p.assertionPeriod = 7200; p.draft.disputePolicy = disputePolicy(p);},
    (p: any) => {p.settlementRules[0].timing.scheduledAt = p.draft.closesAt; p.draft.events[0] = settlementEvent(p.settlementRules[0]);}]) {
    const p = publication(); change(p); expect(() => preparePilot(p, now)).toThrow();
  }
});

test('general manifests register as additional collections and cannot replace the original pilot', async () => {
  const m = manifest(), options = {rpcUrl: 'https://testnet-rpc.monad.xyz', command: async () => null};
  const collection = await configureCollection({...options, manifest: m}); expect(collection.manifest.pool).toBe(m.pool);
  await expect(configurePilot({...options, env: {FLURBO_PILOT_MANIFEST_JSON: JSON.stringify(m)}})).rejects.toThrow(/cannot replace/);
  m.publication.settlementRules[0].decision.value = '4.3';
  await expect(configureCollection({...options, manifest: m})).rejects.toThrow(/committed draft/);
});
