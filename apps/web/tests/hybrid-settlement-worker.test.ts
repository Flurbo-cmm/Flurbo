import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareHybridPilot, hybridRulesHash } from '../scripts/prepare-hybrid-pilot.mjs';
import { hybridSettlementCatalog, nextHybridAction } from '../server/hybrid-settlement-worker.mjs';

const at = 1_800_000_000;
const account = (digit: string) => `0x${digit.repeat(40)}`;
const resolver = account('4'), pool = account('5');
function catalog() {
  const question = 'Will the official value be at least four?';
  const rule = (id: string) => ({ schema: 'flurbo.settlement-rule.v1', eventId: id, question,
    source: { id: 'official-source', publisher: 'Official publisher',
      urls: ['https://data.example.org/value'], adapter: 'json-api.v1',
      reader: { select: '/value', aggregate: 'value' } },
    observation: { series: 'official-value', period: '2027-01', unit: 'units' },
    decision: { type: 'number', operator: 'gte', value: '4' },
    timing: { scheduledAt: at, publicationCutoff: at + 3600,
      correctionCutoff: at + 3600, observationEndsAt: at + 3600,
      assertionPeriod: 3600, challengePeriod: 3600, votingPeriod: 3600 },
    vintage: 'first-observed-snapshot', missingPolicy: 'resolver-timeout-void' });
  const prepared = prepareHybridPilot({ schema: 'flurbo.hybrid-publication.v4', chainId: 10143,
    rulesReviewed: true, creator: account('1'), proposer: account('2'), relay: account('3'),
    title: 'Objective source test pool', closesAt: at - 3600, assertionPeriod: 3600,
    challengePeriod: 3600, reportPeriod: 86400, arbitrationPeriod: 30 * 86400,
    bondAtoms: '1000000', liquidityAtoms: '10000000',
    events: ['first', 'second'].map(id => ({ id, question, observationEndsAt: at + 3600,
      route: 'mechanical', rule: rule(id) })) });
  return { schema: 'flurbo.hybrid-catalog.v1', pools: [{ id: 'objective-test', pool, resolver,
    rulesHash: hybridRulesHash(prepared, resolver), deploymentBlock: 100,
    adapter: account('6'), manager: account('7'), prepared }] };
}
const state = (phase: number, challengeUntil = 0, arbitrationUntil = 0,
  sourceCaseId = `0x${'0'.repeat(64)}`) =>
  ({ phase, challengeUntil, arbitrationUntil, sourceCaseId });

test('catalog refuses changed rules and missing Kleros adapter', () => {
  const value = catalog();
  assert.equal(hybridSettlementCatalog(value).pools.length, 1);
  const changed = structuredClone(value);
  changed.pools[0].prepared.draft.events[0].rule.decision.value = '5';
  assert.throws(() => hybridSettlementCatalog(changed));
  const noAdapter = structuredClone(value);
  delete noAdapter.pools[0].adapter;
  assert.throws(() => hybridSettlementCatalog(noAdapter));
});

test('mechanical proposal, challenge freeze, deadline and delivery are phase driven', () => {
  const prepared = catalog().pools[0].prepared;
  const snapshot = (now: number, states: any[]) => ({ now, states, prepared,
    delivered: false, resolved: false });
  assert.equal(nextHybridAction(snapshot(at, [state(0), state(0)])), null);
  assert.deepEqual(nextHybridAction(snapshot(at + 3600, [state(0), state(0)])),
    { kind: 'propose', event: 0 });
  assert.deepEqual(nextHybridAction(snapshot(at + 3600, [state(1, at + 7200), state(0)])),
    { kind: 'propose', event: 1 });
  assert.deepEqual(nextHybridAction(snapshot(at + 7200, [state(2, 0, at + 30 * 86400), state(1, at + 7200)])),
    { kind: 'finalize', event: 1 });
  assert.deepEqual(nextHybridAction(snapshot(at + 30 * 86400, [state(2, 0, at + 30 * 86400), state(3)])),
    { kind: 'finalize', event: 0 });
  assert.equal(nextHybridAction(snapshot(at + 30 * 86400,
    [state(2, 0, at + 30 * 86400, `0x${'1'.repeat(64)}`), state(3)])), null);
  assert.deepEqual(nextHybridAction(snapshot(at + 30 * 86400, [state(3), state(3)])),
    { kind: 'deliver' });
  assert.deepEqual(nextHybridAction(snapshot(at + 7200, [state(0), state(0)])),
    { kind: 'finalize', event: 0 });
});
