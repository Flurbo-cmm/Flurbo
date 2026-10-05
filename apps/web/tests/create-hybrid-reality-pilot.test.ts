import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askCommand, createHybridRealityPilot } from '../scripts/create-hybrid-reality-pilot.mjs';
import { completeHybridRealityDraft } from '../scripts/complete-hybrid-reality-draft.mjs';
import { prepareHybridPilot } from '../scripts/prepare-hybrid-pilot.mjs';
import { SEPOLIA_KLEROS } from '../server/oracle-integration.mjs';
import { createdTemplate as created, fakeSepolia as fakeClient, txHashes } from './hybrid-reality-fixture.ts';

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
  assert.ok(command.includes(SEPOLIA_KLEROS));
  assert.ok(command.includes('"$(node -p'));
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
