import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadPortfolio, portfolioRequest } from '../src/portfolio-loader.ts';
import { setAppTransport } from '../src/platform-fetch.ts';

const poolAddress = '0x' + '44'.repeat(20), owner = '0x' + '11'.repeat(20);
const hybrid = { kind: 'hybrid' as const, namespace: ('hybrid-' + poolAddress) as `hybrid-0x${string}`, label: 'Reality pool', pool: poolAddress, closesAt: 1 };
const manifest = (pool: string) => ({ pool, publication: { draft: { title: 't', closesAt: 1, events: [{ id: 'a', question: 'A?' }, { id: 'b', question: 'B?' }] } } });

test('hybrid groups load holdings, payouts and history through their own requests', async () => {
  const calls: { path: string; input: any; namespace: string }[] = [], published: any[] = [];
  const request: any = async (path: string, input: any, namespace: string) => {
    calls.push({ path, input, namespace });
    if (path.startsWith('account?wallet=')) return { manifest: manifest(poolAddress), claimScopes: [3] };
    if (path === 'positions') return { owner: input.owner, rows: input.claims.map((c: any) => ({ ...c,
      quantity: c.scope === 1 && c.mask === '2' ? '1000000' : '0', payoutAtoms: '0' })) };
    return { complete: true, logs: [] };
  };
  await loadPortfolio({ groups: [hybrid], account: owner, wallets: [], signal: new AbortController().signal,
    publish: (_namespace, value) => published.push(value), request });
  assert.ok(calls.length >= 4 && calls.every(call => call.namespace === hybrid.namespace));
  const keys = calls.filter(call => call.path === 'positions').flatMap(call => call.input.claims.map((c: any) => `${c.scope}:${c.mask}`));
  for (const key of ['1:1', '1:2', '2:1', '2:2', '3:8', '3:14', '3:6']) assert.ok(keys.includes(key), key);
  const last = published.at(-1);
  assert.equal(last.holdingsComplete, true);
  assert.equal(last.error, undefined);
  assert.ok(last.owners[owner].some((row: any) => row.quantity === '1000000'));
});

test('an account answer for another pool is refused', async () => {
  const calls: string[] = [], published: any[] = [];
  const request: any = async (path: string) => {
    calls.push(path);
    if (path.startsWith('account?wallet=')) return { manifest: manifest('0x' + '55'.repeat(20)), claimScopes: [3] };
    return { complete: true, logs: [] };
  };
  await loadPortfolio({ groups: [hybrid], account: owner, wallets: [], signal: new AbortController().signal,
    publish: (_namespace, value) => published.push(value), request });
  const last = published.at(-1);
  assert.ok(last.error);
  assert.equal(last.holdingsComplete, false);
  assert.ok(!calls.includes('positions'));
});

test('portfolioRequest sends hybrid reads to the pool routes', async () => {
  const seen: { url: string; method: string; body: unknown }[] = [];
  let answer: any = { manifest: { pool: poolAddress } };
  setAppTransport((async (input: any, init: any = {}) => {
    seen.push({ url: String(input), method: init.method || 'GET', body: init.body });
    return new Response(JSON.stringify(answer));
  }) as any);
  const signal = new AbortController().signal;
  try {
    await portfolioRequest('account?wallet=' + owner, undefined, hybrid.namespace, signal);
    assert.deepEqual(seen[0], { url: `/api/hybrid/pool/${poolAddress}/account`, method: 'GET', body: undefined });
    await portfolioRequest('positions', { owner, claims: [] }, hybrid.namespace, signal);
    assert.equal(seen[1].url, `/api/hybrid/pool/${poolAddress}/positions`);
    assert.equal(seen[1].method, 'POST');
    assert.equal(seen[1].body, JSON.stringify({ owner, claims: [] }));
    await assert.rejects(portfolioRequest('status', undefined, hybrid.namespace, signal), /Unsupported portfolio request/);
    answer = { manifest: { pool: '0x' + '55'.repeat(20) } };
    await assert.rejects(portfolioRequest('account?wallet=' + owner, undefined, hybrid.namespace, signal), /Response belongs to a different collection\./);
    const sent = seen.length;
    await assert.rejects(portfolioRequest('history', {}, 'pilot' as never, signal), /Invalid collection/);
    assert.equal(seen.length, sent);
  } finally { setAppTransport(fetch); }
});
