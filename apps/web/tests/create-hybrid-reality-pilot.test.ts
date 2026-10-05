import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askCommand, createHybridRealityPilot } from '../scripts/create-hybrid-reality-pilot.mjs';
import { completeHybridRealityDraft } from '../scripts/complete-hybrid-reality-draft.mjs';
import { prepareHybridPilot } from '../scripts/prepare-hybrid-pilot.mjs';
import { getAddress } from 'viem';
import { SEPOLIA_KLEROS, SEPOLIA_KLEROS_LIQUID, SEPOLIA_KLEROS_SUBCOURT3 } from '../server/oracle-integration.mjs';
import { createdTemplate as created, creator, fakeSepolia as fakeClient, origin, proposer, relay,
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
