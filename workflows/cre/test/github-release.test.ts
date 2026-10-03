import { expect, test } from 'bun:test';
import { observeRelease, releaseEndpoint, releaseEvent, releaseTargetForEvent, MAX_RELEASE_BYTES } from '../src/github-release';

const now = 1_800_000_000;
const target = { repository: 'ethereum/go-ethereum', tag: 'v1.2.3' };
const iso = (n: number) => new Date(n * 1000).toISOString().replace('.000Z', 'Z');
function draft() {
  return { schema: 'flurbo.event-draft.v1', status: 'draft', chainId: 10143,
    clusterId: 'offline-release-fixture', title: 'Offline source adapter tests', closesAt: now - 1000,
    events: [releaseEvent(target, 'geth', now - 900, now - 100),
      releaseEvent({ repository: 'paradigmxyz/reth', tag: 'v2.3.4' }, 'reth', now - 900, now - 100)],
    exceptionPolicy: null, disputeModel: 'external-oracle', disputePolicy: null };
}
function response(patch = {}) {
  return JSON.stringify({ id: 123, tag_name: target.tag, draft: false, prerelease: false,
    url: 'https://api.github.com/repos/ethereum/go-ethereum/releases/123',
    html_url: 'https://github.com/ethereum/go-ethereum/releases/tag/v1.2.3',
    published_at: iso(now - 500), body: 'Public release description', ...patch });
}
const observe = (body = response(), status = 200) => observeRelease(draft(), 'geth', status, body, now);

test('exact stable release produces bound candidate evidence, never a final report', () => {
  const result = observe();
  expect(result.status).toBe('candidate'); expect(result.final).toBe(false);
  if (result.status !== 'candidate') throw new Error('Missing candidate');
  expect(result.candidateOutcome).toBe(true);
  expect(result.releaseId).toBe(123); expect(result.publishedAt).toBe(now - 500);
  expect(result).toEqual(observe());
  expect(result.evidenceHash).not.toBe(observeRelease(draft(), 'geth', 200, response(), now + 1).evidenceHash);
  expect(result.evidenceHash).not.toBe(observe(response({ body: 'Edited source text' })).evidenceHash);
  const changed = draft(); changed.clusterId = 'another-cluster';
  expect(result.evidenceHash).not.toBe(observeRelease(changed, 'geth', 200, response(), now).evidenceHash);
  expect('unsignedReport' in result).toBe(false);
});

test('only reviewed repositories and stable exact version tags construct network URLs', () => {
  expect(releaseEndpoint(target)).toBe('https://api.github.com/repos/ethereum/go-ethereum/releases/tags/v1.2.3');
  for (const change of [{ repository: 'attacker/geth' }, { tag: '../latest' }, { tag: 'v1.2.3?token=x' },
    { tag: 'v1.2.3-rc1' }, { repository: 'https://localhost' }, { url: 'https://attacker.com' }]) {
    expect(() => releaseEndpoint({ ...target, ...change })).toThrow();
  }
  expect(() => releaseTargetForEvent(draft(), 'unknown')).toThrow();
  const changed = draft(); changed.events[0].yesRule = 'YES if a mainnet upgrade activated.';
  expect(() => releaseTargetForEvent(changed, 'geth')).toThrow('template');
  changed.events[0] = releaseEvent(target, 'geth', now - 900, now - 100);
  changed.events[0].source.referenceUrl = 'https://attacker.com/releases';
  expect(() => releaseTargetForEvent(changed, 'geth')).toThrow('template');
});

test('missing, rate-limited and failed reads never become NO evidence', () => {
  for (const status of [404, 401, 403, 429, 500, 503, 302]) {
    const result = observe('remote failure details', status);
    expect(result.status).not.toBe('candidate'); expect(result.final).toBe(false);
    expect('candidateOutcome' in result).toBe(false); expect('evidenceHash' in result).toBe(false);
    expect(JSON.stringify(result)).not.toContain('remote failure details');
  }
});

test('drafts, prereleases and outside-window publications remain unresolved', () => {
  for (const patch of [{ draft: true }, { prerelease: true }, { published_at: null },
    { published_at: iso(now - 901) }, { published_at: iso(now - 100) }]) {
    expect(observe(response(patch)).status).toBe('needs-review');
  }
  expect(observe(response({ published_at: iso(now - 900) })).status).toBe('candidate');
  expect(observe(response({ published_at: iso(now - 101) })).status).toBe('candidate');
});

test('reject malformed, mismatched, oversized and future-dated source responses', () => {
  for (const body of ['<html>proxy failure</html>', '{}', 'x'.repeat(MAX_RELEASE_BYTES + 1),
    response({ id: Number.MAX_SAFE_INTEGER + 1 }), response({ tag_name: 'v9.9.9' }),
    response({ draft: 'false' }), response({ url: 'https://api.github.com/repos/attacker/geth/releases/123' }),
    response({ html_url: 'https://github.com/attacker/geth/releases/tag/v1.2.3' }),
    response({ published_at: iso(now + 1) }), response({ published_at: '2026-02-30T00:00:00Z' }),
    response({ published_at: '2026-01-01T00:00:00+00:00' })]) {
    expect(observe(body).status).toBe('unavailable');
  }
});
