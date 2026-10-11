import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emailConfig, resendDelivery, queueReport, drainEmails } from '../server/settlement-email.mjs';
import { hash } from './pool-fixture.ts';

const config = { from: 'alerts@example.com', to: ['operator@example.com'], key: 're_test-secret' };
const identity = 'test-pool';
const empty = () => ({ schema: 'flurbo.settlement-mail.v1', identity, signature: null, lastQueuedAt: 0, queue: [] });
const report = (checkedAt = 1000, active = true): any => ({ checkedAt, pool: 'pool', resolver: 'resolver',
  snapshot: { blockNumber: String(checkedAt) }, lifecycle: 'trading_closed', status: active ? 'attention_required' : 'observed',
  alerts: active ? [{ code: 'ASSERTION_REVIEW_REQUIRED', severity: 'critical', event: 0, deadline: 5000, message: 'Review evidence.' }] : [],
  events: [{ event: 0, question: 'Fixture?', phase: 'Asserted', proposal: 'YES', counter: 'Unset', result: 'Unset', votes: [0, 0, 0],
    deadline: 5000, evidenceHash: hash, counterEvidenceHash: hash, remainingSeconds: 5000 - checkedAt, action: 'Review assertion.' }],
});

test('a timed out accepted email retries the identical body and idempotency key', async () => {
  let state = queueReport(empty(), report(), config, 1000), calls: any[] = [];
  const send = resendDelivery(config, async (url: any, options: any) => {
    assert.equal(url, 'https://api.resend.com/emails'); calls.push(options);
    if (calls.length === 1) throw new Error('Provider accepted but response lost re_test-secret');
    return Response.json({ id: 'provider-message-id' });
  });
  const save = async (next: any) => { state = structuredClone(next); };
  await assert.rejects(drainEmails(state, { send, save, renew: async () => {}, now: () => 1100 }), /pending delivery retained/);
  assert.equal(state.queue.length, 1);
  const result = await drainEmails(state, { send, save, renew: async () => {}, now: () => 1200 });
  assert.equal(result.state.queue.length, 0);
  assert.equal(calls[0].body, calls[1].body);
  assert.equal(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key']);
});

test('the email transport rejects injected recipients and provider errors and does not expose credentials', async () => {
  assert.throws(() => emailConfig({ FLURBO_MONITOR_EMAIL_TO: 'victim@example.com\nbcc:other@example.com' }));
  const item = queueReport(empty(), report(), config, 1000).queue[0];
  const send = resendDelivery(config, async () => new Response('re_test-secret', { status: 429 }));
  await assert.rejects(send(item), error => !String(error).includes('re_test-secret'));
});

