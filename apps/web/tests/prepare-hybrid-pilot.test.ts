import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAbiParameters, encodeAbiParameters, keccak256, parseAbiParameters } from 'viem';
import { readFileSync } from 'node:fs';
import { hybridConfigAbi, hybridRulesHash, isLsPrepared, LS_PREPARED, prepareHybridPilot, realityQuestionText } from '../scripts/prepare-hybrid-pilot.mjs';
import { settlementRuleHash } from '../server/settlement-rules.mjs';
import { hybridSettlementCatalog } from '../server/hybrid-settlement-worker.mjs';
import { SEPOLIA_KLEROS, SEPOLIA_KLEROS_LIQUID, SEPOLIA_KLEROS_SUBCOURT3, SEPOLIA_REALITY } from '../server/oracle-integration.mjs';
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

function realityPublication() {
  const input = publication();
  input.events = input.events.map((event, index) => {
    const ruleURI = `https://flurbopm.singu.online/api/hybrid/rules/0x${settlementRuleHash(event.rule)}`;
    return { id: event.id, question: event.question, observationEndsAt: event.observationEndsAt,
      route: 'reality', rule: event.rule, source: { kind: 'reality-sepolia', chainId: 11155111,
        reality: SEPOLIA_REALITY, arbitrator: SEPOLIA_KLEROS, ruleURI,
        questionId: `0x${String(index + 5).repeat(64)}`, contentHash: `0x${String(index + 7).repeat(64)}`,
        questionTxHash: `0x${["a", "b"][index].repeat(64)}`,
        questionText: realityQuestionText(event.question, ruleURI), minTimeout: 3600,
        minBond: '100000000000000', openingAt: event.observationEndsAt } };
  });
  return input;
}

test('reality event with an answer rule commits both rule and source', () => {
  const input = realityPublication();
  const prepared = prepareHybridPilot(input);
  const abi = parseAbiParameters('(address collateral,bytes32 draftHash,uint64 closesAt,bytes32[] eventHashes,uint64[] observationEnds,uint8[] routes,address proposer,address relay,uint128 bond,uint32 assertionPeriod,uint32 challengePeriod,uint32 reportPeriod,uint32 arbitrationPeriod) config');
  const [config] = decodeAbiParameters(abi, prepared.resolverConfig);
  assert.deepEqual(config.routes, [1, 1]);
  const changed = realityPublication();
  changed.events[0].rule.decision.value = '5';
  changed.events[0].source.ruleURI = `https://flurbopm.singu.online/api/hybrid/rules/0x${settlementRuleHash(changed.events[0].rule)}`;
  changed.events[0].source.questionText = realityQuestionText(changed.events[0].question, changed.events[0].source.ruleURI);
  assert.notEqual(prepareHybridPilot(changed).eventHashes[0], prepared.eventHashes[0]);
});

test('reality source accepts only the official proxy and the subcourt 3 copy', () => {
  const input = (arbitrator: string) => {
    const base = realityPublication();
    return { ...base, events: base.events.map(event => ({ ...event, source: { ...event.source, arbitrator } })) };
  };
  assert.doesNotThrow(() => prepareHybridPilot(input(SEPOLIA_KLEROS_SUBCOURT3)));
  assert.doesNotThrow(() => prepareHybridPilot(input(SEPOLIA_KLEROS)));
  assert.throws(() => prepareHybridPilot(input(`0x${'1'.repeat(40)}`)), /Invalid Reality source/);
  assert.throws(() => prepareHybridPilot(input(SEPOLIA_KLEROS_LIQUID)), /Invalid Reality source/);
});

test('reality question text must embed the rule URI', () => {
  const input = realityPublication();
  input.events[0].source.questionText = `${input.events[0].question}␟flurbo␟en`;
  assert.throws(() => prepareHybridPilot(input), /Invalid Reality source/);
});

test('rule URI must carry the rule hash', () => {
  const input = realityPublication();
  input.events[0].source.ruleURI = `https://flurbopm.singu.online/api/hybrid/rules/0x${'a'.repeat(64)}`;
  input.events[0].source.questionText = realityQuestionText(input.events[0].question, input.events[0].source.ruleURI);
  assert.throws(() => prepareHybridPilot(input), /Invalid Reality source/);
});

test('reality rule timing must match the Reality timeout', () => {
  const input = realityPublication();
  input.events[0].source.minTimeout = 7200;
  assert.throws(() => prepareHybridPilot(input), /Reality rule differs from its event/);
});

test('committed hybrid catalog still re-prepares', () => {
  const catalog = JSON.parse(readFileSync(new URL('../../../config/hybrid-markets.json', import.meta.url), 'utf8'));
  assert.doesNotThrow(() => hybridSettlementCatalog(catalog));
});

test('v5 publication commits the commission and keeps the rules hash domain', () => {
  const prepared = prepareHybridPilot({ ...publication(), schema: 'flurbo.hybrid-publication.v5', commissionBps: 500 });
  assert.equal(prepared.schema, 'flurbo.hybrid-prepared.v5');
  assert.equal(LS_PREPARED, 'flurbo.hybrid-prepared.v5');
  assert.equal(isLsPrepared(prepared), true);
  assert.equal(isLsPrepared(prepareHybridPilot(publication())), false);
  assert.equal(prepared.commissionBps, 500);
  assert.equal(prepared.draft.commissionBps, 500);
  assert.equal(prepared.liquidityAtoms, '10000000');
  assert.deepEqual(Object.keys(prepared.draft).slice(-3), ['liquidityAtoms', 'commissionBps', 'events']);
  const other = prepareHybridPilot({ ...publication(), schema: 'flurbo.hybrid-publication.v5', commissionBps: 1000 });
  assert.notEqual(other.draftHash, prepared.draftHash);
  assert.notEqual(prepareHybridPilot(publication()).draftHash, prepared.draftHash);
  const resolver = account('4');
  const [config] = decodeAbiParameters(hybridConfigAbi, prepared.resolverConfig);
  const manual = keccak256(encodeAbiParameters([
    ...parseAbiParameters('string domain,uint256 chainId,address resolver,address creator'), ...hybridConfigAbi,
  ], ['flurbo.pilot.hybrid.v4', 10143n, resolver, prepared.creator, config]));
  assert.equal(hybridRulesHash(prepared, resolver), manual);
});

test('v5 rejects a commission outside 100 to 2000, and v4 rejects any commission', () => {
  for (const commissionBps of [99, 2001, 1.5, '500', null, undefined])
    assert.throws(() => prepareHybridPilot({ ...publication(), schema: 'flurbo.hybrid-publication.v5', commissionBps }),
      /Invalid hybrid publication/);
  for (const commissionBps of [100, 2000])
    assert.equal(prepareHybridPilot({ ...publication(), schema: 'flurbo.hybrid-publication.v5', commissionBps }).commissionBps, commissionBps);
  assert.throws(() => prepareHybridPilot({ ...publication(), commissionBps: 500 }), /Invalid hybrid publication/);
  assert.throws(() => prepareHybridPilot({ ...publication(), schema: 'flurbo.hybrid-publication.v6', commissionBps: 500 }),
    /Invalid hybrid publication/);
});
