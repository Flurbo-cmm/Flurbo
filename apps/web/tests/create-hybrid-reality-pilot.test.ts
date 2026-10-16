import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askCommand, createHybridRealityPilot, defaultHybridRealityRules } from '../scripts/create-hybrid-reality-pilot.mjs';
import { completeHybridRealityDraft } from '../scripts/complete-hybrid-reality-draft.mjs';
import { hybridRulesHash, prepareHybridPilot } from '../scripts/prepare-hybrid-pilot.mjs';
import { verifyHybridDeployment } from '../scripts/register-hybrid-pool.mjs';
import { createHybridEvmPilot } from '../scripts/create-hybrid-evm-pilot.mjs';
import { checkRule } from '../scripts/check-settlement-rule.mjs';
import { getAddress, keccak256 } from 'viem';
import { SEPOLIA_KLEROS, SEPOLIA_KLEROS_LIQUID, SEPOLIA_KLEROS_SUBCOURT3, TEST_AUSD } from '../server/oracle-integration.mjs';
import { depthRateWad } from '../shared/ls-lmsr.mjs';
import { createdTemplate as created, creator, fakeSepolia as fakeClient, origin, proposer, proxyCode, relay,
  txHashes } from './hybrid-reality-fixture.ts';

test('template carries two rule-backed Reality events and exact ask commands', () => {
  const template = created();
  assert.equal(template.schema, 'flurbo.hybrid-reality-template.v1');
  assert.equal(template.questions.length, 2);
  template.questions.forEach((item: any, index: number) => {
    const event = template.draft.events[index];
    assert.ok(item.questionText.endsWith('␟flurbo␟en'));
    assert.ok(item.questionText.includes(event.source.ruleURI));
    assert.equal(item.opening, event.observationEndsAt);
    assert.equal(event.route, 'reality');
  });
  const command = askCommand(template, 0, 'tpl.json');
  assert.ok(command.includes('askQuestionWithMinBond(uint256,string,address,uint32,uint32,uint256,uint256)'));
  assert.ok(command.includes(SEPOLIA_KLEROS_SUBCOURT3));
  assert.ok(command.includes('"$(node -p'));
  template.draft.events.forEach((event: any) => assert.equal(event.source.arbitrator, SEPOLIA_KLEROS_SUBCOURT3));
  assert.equal(template.draft.title, 'Monad testnet Reality reader pool');
});

test('template can pin the official proxy and a title', () => {
  const template = createHybridRealityPilot({ creator, proposer, relay, closesAt: Math.floor(Date.now() / 1000) + 3 * 3600,
    origin, arbitrator: SEPOLIA_KLEROS, title: 'Monad testnet Kleros challenge pool' });
  template.draft.events.forEach((event: any) => assert.equal(event.source.arbitrator, getAddress(SEPOLIA_KLEROS)));
  assert.ok(askCommand(template, 1, 'tpl.json').includes(getAddress(SEPOLIA_KLEROS)));
  assert.equal(template.draft.title, 'Monad testnet Kleros challenge pool');
});

test('template refuses an unsupported arbitrator and a short title', () => {
  const base = { creator, proposer, relay, closesAt: Math.floor(Date.now() / 1000) + 3 * 3600, origin };
  assert.throws(() => createHybridRealityPilot({ ...base, arbitrator: SEPOLIA_KLEROS_LIQUID }),
    /Choose a supported Kleros arbitrator proxy/);
  assert.throws(() => createHybridRealityPilot({ ...base, title: 'short' }),
    /Choose a title of 8 to 120 characters/);
});

test('complete draft verifies each creation receipt', async () => {
  const template = created();
  const hashes = txHashes;
  const draft = await completeHybridRealityDraft(template, hashes, fakeClient(template));
  assert.doesNotThrow(() => prepareHybridPilot(draft));
  assert.equal(draft.events[0].source.questionTxHash, hashes[0]);
  await assert.rejects(() => completeHybridRealityDraft(template, hashes,
    fakeClient(template, { questionText: 'another question␟flurbo␟en' })),
  /Pinned Reality question, title, creator or opening time mismatch/);
});

test('complete draft rejects a question asked with another arbitrator', async () => {
  const template = created();
  await assert.rejects(() => completeHybridRealityDraft(template, txHashes,
    fakeClient(template, { arbitrator: SEPOLIA_KLEROS })),
  /Pinned Reality question, title, creator or opening time mismatch/);
});

test('both creation scripts emit v5 drafts with the default commission', () => {
  const template = created();
  assert.equal(template.draft.schema, 'flurbo.hybrid-publication.v5');
  assert.equal(template.draft.commissionBps, 500);
  const evm = createHybridEvmPilot({ creator, proposer, relay, closesAt: Math.floor(Date.now() / 1000) + 3 * 3600 });
  assert.equal(evm.schema, 'flurbo.hybrid-publication.v5');
  assert.equal(evm.commissionBps, 500);
  assert.equal(prepareHybridPilot(evm).schema, 'flurbo.hybrid-prepared.v5');
});

test('creates, completes, prepares and registers a mixed automated and human-route Reality pool', async () => {
  const closesAt = Math.floor(Date.now() / 1000) + 3 * 3600;
  const human = {
    schema: 'flurbo.human-question.v1',
    eventId: 'reality-human-1',
    question: 'Will UKMTO publish an official incident advisory for the Red Sea between 16 October 2026 14:00 UTC and 17 October 2026 06:00 UTC?',
    observationEndsAt: closesAt + 7200,
    challengePeriod: 3600,
  };
  const checked = await checkRule(human, { closesAt });
  assert.equal(checked.status, 'ok');
  assert.equal(checked.route, 'reality-human');
  const invalidCheck = await checkRule({ ...human, observationEndsAt: closesAt }, { closesAt });
  assert.equal(invalidCheck.status, 'invalid');

  const rules = [defaultHybridRealityRules(closesAt)[0], human];
  const template = createHybridRealityPilot({ creator, proposer, relay, closesAt, origin, rules });
  assert.equal(template.questions.length, 2);
  assert.equal('rule' in template.draft.events[0], true);
  assert.equal('rule' in template.draft.events[1], false);
  assert.equal('ruleURI' in template.draft.events[1].source, false);
  assert.equal('ruleURI' in template.questions[1], false);
  assert.equal(template.questions[1].questionText, `${human.question}␟flurbo␟en`);

  const draft = await completeHybridRealityDraft(template, txHashes, fakeClient(template));
  const prepared = prepareHybridPilot(draft);
  assert.equal(prepared.schema, 'flurbo.hybrid-prepared.v5');
  assert.equal(prepared.eventHashes.length, 2);

  const pool = `0x${'5'.repeat(40)}`, resolver = `0x${'4'.repeat(40)}`;
  const rulesHash = hybridRulesHash(prepared, resolver);
  const unverified = { schema: 'flurbo.hybrid-manifest.v5', status: 'unverified_deployment',
    pool, resolver, creator: prepared.creator, proposer: prepared.proposer, relay: prepared.relay,
    draftHash: prepared.draftHash, configHash: prepared.configHash, rulesHash,
    commissionBps: prepared.commissionBps, initialDepthAtoms: Number(prepared.liquidityAtoms),
    depthRate: Number(depthRateWad(2, prepared.commissionBps)) };
  const market = {
    getChainId: async () => 10143,
    getBlock: async () => ({ hash: `0x${'9'.repeat(64)}`, number: 200n, timestamp: 1000n }),
    readContract: async ({ address, functionName, args = [] }: any) => {
      const isPool = address.toLowerCase() === pool.toLowerCase();
      const values: Record<string, unknown> = {
        protocolVersion: isPool ? 5 : 4, rulesHash, draftHash: prepared.draftHash, pool,
        liquidity: BigInt(prepared.liquidityAtoms), commissionBps: prepared.commissionBps, sponsor: prepared.creator,
        proposer: prepared.proposer, relay: prepared.relay, bond: 1000000n, eventCount: 2n,
        resolver, settlementRulesHash: rulesHash, collateral: TEST_AUSD, funded: true,
        resolved: false, delivered: false, routes: 1n,
        eventHashes: prepared.eventHashes[Number(args[0])],
        observationEnds: BigInt(prepared.draft.events[Number(args[0])]?.observationEndsAt ?? 0),
        caseState: { phase: 0n, challengeUntil: 0n, arbitrationUntil: 0n, sourceCaseId: `0x${'0'.repeat(64)}` },
      };
      return values[functionName];
    },
  };
  const record = await verifyHybridDeployment({ id: 'mixed-test', prepared, unverified,
    keeper: `0x${'8'.repeat(40)}`, answerer: `0x${'9'.repeat(40)}`, market,
    source: fakeClient(template), proxyCodeHash: keccak256(proxyCode) });
  assert.equal(record.id, 'mixed-test');
});

test('rejects a human-route question whose observation time is not after closesAt or has duplicate id', () => {
  const closesAt = Math.floor(Date.now() / 1000) + 3 * 3600;
  const first = defaultHybridRealityRules(closesAt)[0];
  assert.throws(() => createHybridRealityPilot({ creator, proposer, relay, closesAt, origin,
    rules: [first, { schema: 'flurbo.human-question.v1', eventId: 'reality-human-1',
      question: 'Will the advisory be published?', observationEndsAt: closesAt }] }),
  /Invalid human question/);
  assert.throws(() => createHybridRealityPilot({ creator, proposer, relay, closesAt, origin,
    rules: [first, { schema: 'flurbo.human-question.v1', eventId: first.eventId,
      question: 'Will the advisory be published?', observationEndsAt: closesAt + 3600 }] }),
  /Duplicate event id/);
});
