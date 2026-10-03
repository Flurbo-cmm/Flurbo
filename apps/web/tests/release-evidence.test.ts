import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legacyReleaseEvidence } from '../scripts/run-resolution.mjs';

const manifest = { draftHash: '0x' + 'aa'.repeat(32) };
const event = { id: 'geth-1-17-7' };
const facts = { releaseId: 123, tag: 'v1.17.7', publishedAt: '2026-10-02T10:00:00Z', draft: false, prerelease: false };
const report = (recommendation: string, ai: any) => ({ reportHash: 'r1', assessment: { recommendation, facts: recommendation === 'YES' ? facts : null, payloadHash: 'p1' },
  evidence: [{ endpoint: 'https://api.github.com/repos/ethereum/go-ethereum/releases/tags/v1.17.7', payloadHash: 'p1' }], ai });
function harness(r: any) {
  const puts: any[] = [], reviews: boolean[] = [];
  const archive = { put: async (input: any) => { puts.push(input); return { evidenceHash: '0x' + '11'.repeat(32), evidenceURI: 'https://flurbo.singu.online/x' }; } };
  const assistant = { review: async (_id: string, useAI: boolean) => { reviews.push(useAI); return r; } };
  return { puts, reviews, run: (env: Record<string, string>) => legacyReleaseEvidence({ manifest, event, env, archive, owner: '0x' + '67'.repeat(20), assistant }) };
}

test('a deterministic YES is asserted without any AI configured, with a factual statement', async () => {
  const h = harness(report('YES', { status: 'not-requested', model: null, explanation: null }));
  const result = await h.run({});
  assert.deepEqual(h.reviews, [false], 'no model call is attempted without configuration');
  assert.equal(result!.outcome, 2);
  assert.match(h.puts[0].statement, /v1\.17\.7 \(release 123\) was published as a stable release at 2026-10-02T10:00:00Z/);
  assert.equal('ai' in JSON.parse(h.puts[0].attachment), false);
});

test('a rate-limited or failed model never blocks the YES assertion', async () => {
  const h = harness(report('YES', { status: 'unavailable', model: 'gemini-x', explanation: null }));
  const result = await h.run({ FLURBO_EVIDENCE_FREE_TIER_CONFIRMED: 'true', FLURBO_EVIDENCE_GEMINI_KEY: 'k' });
  assert.deepEqual(h.reviews, [true]);
  assert.equal(result!.outcome, 2);
  assert.match(h.puts[0].statement, /^Automatic YES from the official GitHub release record/);
});

test('a generated explanation is attached when available', async () => {
  const summary = 'The exact stable tag was published inside the window per the official API.';
  const h = harness(report('YES', { status: 'generated', model: 'gemini-x', explanation: { summary } }));
  await h.run({ FLURBO_EVIDENCE_FREE_TIER_CONFIRMED: 'true', FLURBO_EVIDENCE_GEMINI_KEY: 'k' });
  assert.equal(h.puts[0].statement, summary);
  assert.equal(JSON.parse(h.puts[0].attachment).ai.status, 'generated');
});

test('anything other than a deterministic YES asserts nothing; NO is never inferred', async () => {
  const h = harness(report('ABSTAIN', { status: 'generated', model: 'gemini-x', explanation: { summary: 'x'.repeat(40) } }));
  assert.equal(await h.run({}), null);
  assert.equal(h.puts.length, 0);
});
