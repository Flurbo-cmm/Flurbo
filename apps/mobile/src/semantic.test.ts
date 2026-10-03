import assert from 'node:assert/strict';
import { test } from 'node:test';
import { semanticAcknowledgment } from '../../web/src/pilot.ts';
import { semanticReady, submitOptions } from './semantic.ts';

const review = (semanticAssessment: any, action = 'buy') => ({ requested: { action }, semanticAssessment }) as any;
const collision = review({ mode: 'enforced', status: 'collision', rulesDigest: 'd'.repeat(64), configRevision: 'a'.repeat(64) });

test('mobile passes its own market to the shared purchase check', () => {
  for (const namespace of ['pilot', `practice-${'1'.repeat(40)}`] as const)
    assert.equal(submitOptions(collision, namespace, { review: null, phrase: '' }).namespace, namespace);
});
test('a known collision needs the exact phrase for this review; disabled and unchecked purchases do not', () => {
  assert.equal(semanticReady(collision, { review: null, phrase: '' }), false);
  assert.equal(semanticReady(collision, { review: collision, phrase: 'yes' }), false);
  assert.equal(semanticReady(collision, { review: review(collision.semanticAssessment), phrase: semanticAcknowledgment }), false, 'phrase typed for another review');
  assert.equal(semanticReady(collision, { review: collision, phrase: semanticAcknowledgment }), true);
  assert.deepEqual(submitOptions(collision, 'pilot', { review: collision, phrase: semanticAcknowledgment }).acknowledgment, { rulesDigest: 'd'.repeat(64), phrase: semanticAcknowledgment });
  for (const r of [review({ mode: 'disabled', configRevision: 'b'.repeat(64) }), review(null), review({ mode: 'enforced', status: 'unknown' }), review({ mode: 'enforced', status: 'collision' }, 'sell')])
    assert.equal(semanticReady(r, { review: null, phrase: '' }), true);
});
