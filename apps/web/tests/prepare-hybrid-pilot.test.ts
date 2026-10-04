import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAbiParameters, parseAbiParameters } from 'viem';
import { prepareHybridPilot } from '../scripts/prepare-hybrid-pilot.mjs';
import { createHybridEvmPilot } from '../scripts/create-hybrid-evm-pilot.mjs';

const T = 1_800_000_000;
const account = (digit: string) => `0x${digit.repeat(40)}`;
function publication() {
  const question = 'Will the official value be at least four?';
  const rule = (id: string) => ({ schema: 'flurbo.settlement-rule.v1', eventId: id, question,
    source: { id: 'source-1', publisher: 'Official publisher', urls: ['https://data.example.org/value'],
      adapter: 'json-api.v1', reader: { select: '/value', aggregate: 'value' } },
    observation: { series: 'official-value', period: '2027-01', unit: 'units' },
    decision: { type: 'number', operator: 'gte', value: '4' },
    timing: { scheduledAt: T, publicationCutoff: T + 3600, correctionCutoff: T + 3600,
      observationEndsAt: T + 3600, assertionPeriod: 3600, challengePeriod: 3600, votingPeriod: 3600 },
    vintage: 'first-observed-snapshot', missingPolicy: 'resolver-timeout-void' });
  return { schema: 'flurbo.hybrid-publication.v4', chainId: 10143, rulesReviewed: true,
    creator: account('1'), proposer: account('2'), relay: account('3'), title: 'New objective test pool',
    closesAt: T - 3600, assertionPeriod: 3600, challengePeriod: 3600, reportPeriod: 86400,
    arbitrationPeriod: 30 * 86400, bondAtoms: '1000000', liquidityAtoms: '10000000',
    events: ['first', 'second'].map(id => ({ id, question, observationEndsAt: T + 3600,
      route: 'mechanical', rule: rule(id) })) };
}

test('hybrid publication binds each event and ABI encodes the resolver config', () => {
  const input = publication();
  const prepared = prepareHybridPilot(input);
  const abi = parseAbiParameters('(address collateral,bytes32 draftHash,uint64 closesAt,bytes32[] eventHashes,uint64[] observationEnds,uint8[] routes,address proposer,address relay,uint128 bond,uint32 assertionPeriod,uint32 challengePeriod,uint32 reportPeriod,uint32 arbitrationPeriod) config');
  const [config] = decodeAbiParameters(abi, prepared.resolverConfig);
  assert.equal(prepared.schema, 'flurbo.hybrid-prepared.v4');
  assert.equal(config.draftHash, prepared.draftHash);
  assert.deepEqual(config.eventHashes, prepared.eventHashes);
  assert.deepEqual(config.routes, [0, 0]);
  assert.equal(config.bond, 1000000n);
  const changed = publication();
  changed.events[0].rule.decision.value = '5';
  assert.notEqual(prepareHybridPilot(changed).draftHash, prepared.draftHash);
});

test('hybrid publication rejects reviewer route drift and oversized pool', () => {
  const input = publication();
  input.events[0].route = 'reality';
  assert.throws(() => prepareHybridPilot(input), /Reality source/);
  input.events[0].route = 'mechanical';
  input.liquidityAtoms = '1000000000001';
  assert.throws(() => prepareHybridPilot(input), /Invalid hybrid publication/);
});

test('pilot generator preserves ordinary address checksums for every wallet role', () => {
  const input = createHybridEvmPilot({
    creator: '0xF1feA08EbBa92eD342Acc5639dB312C3694Bc391',
    proposer: '0xa45c95f673580132F2E6f75372808162Ea069d49',
    relay: '0x51dd3f8eD77e49e8099b79d455F16b0bF8e120E1',
    closesAt: Math.floor(Date.now() / 1000) + 10800,
  });
  assert.equal(prepareHybridPilot(input).draft.events.length, 2);
});
