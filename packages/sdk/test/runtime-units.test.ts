import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey } from 'viem/accounts';
import { httpRetriever, openAiCompatible, anthropicMessages, researcher, fixtureRetriever, fixtureForecaster, ProviderError, extractText } from '../src/node/research.ts';
import { runtimeClient, RuntimeApiError } from '../src/node/headless.ts';
import { FileJournal } from '../src/node/journal.ts';
import { localKeySigner, signerFromEnv } from '../src/node/signer.ts';
import { main } from '../src/node/cli.ts';
import { parseConfig, defaultConfig } from '../src/node/runner.ts';
import { MODEL_SCHEMA } from '../src/research.ts';
import { evidenceFixture } from './evidence-fixture.ts';

const TOKEN = 'fla1_0123456789abcdef_' + 'A'.repeat(43);
type Call = { url: string; init: RequestInit };
const stubFetch = (respond: (call: Call, n: number) => Response | Promise<Response>) => { const calls: Call[] = []; const f = (async (url: string, init: RequestInit) => { calls.push({ url: String(url), init }); return respond({ url: String(url), init }, calls.length); }) as unknown as typeof fetch; return { f, calls }; };
const json = (v: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } });

test('retrieval: only allowlisted HTTPS hosts, redirects re-checked, bounded, text extracted', async () => {
  const { f, calls } = stubFetch(call => {
    if (call.url.startsWith('https://allowed.example/redirect')) return new Response(null, { status: 302, headers: { location: 'https://evil.example/page' } });
    return new Response('<html><title>Release 1.0</title><script>steal()</script><p>Tagged &amp; released</p></html>', { status: 200, headers: { 'content-type': 'text/html', 'last-modified': 'Sat, 26 Sep 2026 10:00:00 GMT' } });
  });
  const r = httpRetriever({ allowHosts: ['allowed.example'], fetch: f });
  const got = await r.retrieve([{ event: 0, url: 'https://allowed.example/a' }, { event: 1, url: 'http://allowed.example/b' }, { event: 1, url: 'https://evil.example/c' }, { event: 0, url: 'https://allowed.example/redirect' }], 1_790_000_000);
  assert.equal(got.length, 1, 'plain HTTP, other hosts and redirects to other hosts are skipped');
  assert.deepEqual([got[0].id, got[0].title, got[0].excerpt, got[0].publisherReleasedAt, got[0].httpLastModified], ['src-1', 'Release 1.0', 'Release 1.0 Tagged & released', null, Date.parse('Sat, 26 Sep 2026 10:00:00 GMT') / 1000]);
  assert.ok(!calls.some(c => c.url.includes('evil.example')), 'a redirect to another host is never followed');
  assert.equal(extractText('<style>x{}</style><b>a</b>  b'), 'a b');
});

test('model providers: timeouts, bounded retries, rate limits and missing configuration become abstentions', async () => {
  assert.throws(() => openAiCompatible({ baseUrl: 'https://api.example/v1', model: 'm', apiKey: null }), (e: ProviderError) => e.reason === 'provider_not_configured');
  assert.throws(() => anthropicMessages({ model: 'm', apiKey: null }), (e: ProviderError) => e.reason === 'provider_not_configured');
  assert.throws(() => openAiCompatible({ baseUrl: 'http://api.example/v1', model: 'm', apiKey: 'k' }), /HTTPS/);
  // Retries 5xx then succeeds; the key goes in a header, never the URL.
  const ok = stubFetch((_c, n) => (n < 3 ? json({ error: 'busy' }, 503, { 'retry-after': '0' }) : json({ choices: [{ message: { content: '{"x":1}' } }] })));
  const p = openAiCompatible({ baseUrl: 'https://api.example/v1', model: 'm', apiKey: 'sk-secret', maxRetries: 2, fetch: ok.f });
  assert.equal(await p.complete({ system: 's', user: 'u' }), '{"x":1}');
  assert.equal(ok.calls.length, 3);
  assert.ok(ok.calls.every(c => !c.url.includes('sk-secret') && (c.init.headers as Record<string, string>).Authorization === 'Bearer sk-secret'));
  // Persistent 429 is bounded and reported as rate limited, without the provider's error text.
  const limited = stubFetch(() => json({ error: { message: 'key sk-secret over quota' } }, 429, { 'retry-after': '0' }));
  await assert.rejects(openAiCompatible({ baseUrl: 'https://api.example/v1', model: 'm', apiKey: 'sk-secret', maxRetries: 1, fetch: limited.f }).complete({ system: 's', user: 'u' }),
    (e: ProviderError) => e.reason === 'rate_limited' && !e.message.includes('sk-secret'));
  assert.equal(limited.calls.length, 2);
  // Timeout.
  const slow = (async (_u: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('t'), { name: 'TimeoutError' }))))) as unknown as typeof fetch;
  await assert.rejects(openAiCompatible({ baseUrl: 'https://api.example/v1', model: 'm', apiKey: 'k', timeoutMs: 50, maxRetries: 0, fetch: slow }).complete({ system: 's', user: 'u' }), (e: ProviderError) => e.reason === 'timeout');
  // Anthropic wire format.
  const a = stubFetch(call => { assert.equal((call.init.headers as Record<string, string>)['x-api-key'], 'k2'); return json({ content: [{ type: 'text', text: 'hello' }] }); });
  assert.equal(await anthropicMessages({ model: 'm', apiKey: 'k2', fetch: a.f }).complete({ system: 's', user: 'u' }), 'hello');
});

test('research budgets and missing providers abstain without calling anything', async () => {
  const good = JSON.stringify({ schema: MODEL_SCHEMA, abstain: false, abstainReason: null, events: [0, 1], statesPpm: [250000, 250000, 250000, 250000], evidenceIds: ['src-1'], assumptions: [], uncertainty: 'Unknown.', explanation: 'Evenly uncertain about both.' });
  let calls = 0;
  const r = researcher({ retriever: fixtureRetriever([evidenceFixture({ publisherReleasedAt: 1_790_000_000 - 60 })]),
    forecaster: fixtureForecaster(() => { calls++; return good; }), maxEvidenceAgeSeconds: 86_400, perCycle: 1, perHour: 2, now: () => 1_790_000_000 });
  const input = { pool: '0x' + '11'.repeat(20), title: 't', eventCount: 2, events: [0, 1].map(index => ({ index, question: 'q', yesRule: 'y', noRule: 'n', observationEndsAt: 1_800_000_000 })), sources: [] };
  assert.equal((await r.research(input)).status, 'ok');
  assert.deepEqual([(await r.research(input) as any).reason, calls], ['request_budget_exhausted', 1], 'per-cycle budget');
  r.resetCycle(); await r.research(input); r.resetCycle();
  assert.deepEqual([(await r.research(input) as any).reason, calls], ['request_budget_exhausted', 2], 'per-hour budget');
  const none = researcher({ retriever: fixtureRetriever([]), forecaster: new ProviderError('provider_not_configured', 'No provider.'), maxEvidenceAgeSeconds: 1, perCycle: 1, perHour: 1 });
  assert.equal((await none.research(input) as any).reason, 'provider_not_configured');
});

test('headless client: credential only in the Authorization header, protocol header on every call, safe errors', async () => {
  assert.throws(() => runtimeClient({ baseUrl: 'https://x.example', token: 'not-a-token' }), /credential/);
  assert.throws(() => runtimeClient({ baseUrl: 'http://x.example', token: TOKEN }), /HTTPS/);
  const { f, calls } = stubFetch((_c, n) => (n === 1 ? json({ schema: 'flurbo.agent-runtime-policy.v1', version: 1 }) : json({ code: 'CREDENTIAL_REVOKED', error: 'This agent credential was revoked.', retryable: false }, 401)));
  const client = runtimeClient({ baseUrl: 'https://flurbo.example', token: TOKEN, fetch: f });
  await client.policy();
  await assert.rejects(client.session(), (e: RuntimeApiError) => e.apiCode === 'CREDENTIAL_REVOKED' && e.stop && !e.message.includes(TOKEN));
  for (const c of calls) {
    assert.ok(!c.url.includes(TOKEN) && !c.url.includes('?'));
    const h = c.init.headers as Record<string, string>;
    assert.equal(h.Authorization, `Bearer ${TOKEN}`); assert.equal(h['Flurbo-Agent-Protocol'], '1');
  }
  const offline = runtimeClient({ baseUrl: 'https://flurbo.example', token: TOKEN, fetch: (async () => { throw new Error(`connect ${TOKEN}`); }) as unknown as typeof fetch });
  await assert.rejects(offline.session(), (e: RuntimeApiError) => e.apiCode === 'NETWORK' && !e.message.includes(TOKEN));
});

test('the journal lock serialises separate operating-system processes', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'flurbo-lock-')), wallet = '0x' + '22'.repeat(20);
  const script = join(dir, 'worker.ts');
  writeFileSync(script, `import { FileJournal } from ${JSON.stringify(new URL('../src/node/journal.ts', import.meta.url).href)};
const j = new FileJournal(${JSON.stringify(dir)}, ${JSON.stringify(wallet)});
for (let i = 0; i < 40; i++) await j.locked(file => { const n = file.entries.length; file.entries.push({ id: process.pid + '-' + i, seq: n } as any); });`);
  const run = () => new Promise<number>(r => spawn(process.execPath, [script], { stdio: 'inherit' }).on('exit', code => r(code ?? 1)));
  try {
    assert.deepEqual(await Promise.all([run(), run(), run()]), [0, 0, 0]);
    const entries = JSON.parse(readFileSync(join(dir, 'journal.json'), 'utf8')).entries;
    assert.equal(entries.length, 120, 'no lost updates');
    assert.deepEqual(entries.map((e: any) => e.seq), entries.map((_: unknown, i: number) => i), 'every write saw the previous one');
    assert.throws(() => new FileJournal(dir, '0x' + '33'.repeat(20)).read(), /one state directory per agent wallet/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('signer and CLI: keys only from the environment, association messages only for the agent wallet', async () => {
  assert.throws(() => signerFromEnv('FLURBO_TEST_MISSING_KEY', {}), /Set FLURBO_TEST_MISSING_KEY/);
  assert.throws(() => localKeySigner('0x1234'), /32 bytes/);
  const key = generatePrivateKey(), signer = localKeySigner(key), dir = mkdtempSync(join(tmpdir(), 'flurbo-cli-'));
  const out: string[] = [], err: string[] = [], io = { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, config = join(dir, 'flurbo-agent.json');
  try {
    assert.equal(await main(['init', '--config', config], io), 0);
    assert.doesNotThrow(() => parseConfig(JSON.parse(readFileSync(config, 'utf8'))));
    assert.ok(!readFileSync(config, 'utf8').includes(key.slice(2)), 'no secrets in the configuration');
    assert.equal(await main(['init', '--config', config], io), 1, 'never overwrites');
    const message = (wallet: string) => `Flurbo agent wallet association\nOrigin: http://localhost\nMera account: 0x${'44'.repeat(20)}\nAgent: a\nAgent wallet: ${wallet}\nChain: Monad testnet (10143)\nNonce: n\nIssued: x\nExpires: y\nThis proves control of this wallet.`;
    writeFileSync(join(dir, 'm.txt'), message(signer.address));
    process.env.FLURBO_AGENT_PRIVATE_KEY = key;
    out.length = 0;
    assert.equal(await main(['sign-message', '--file', join(dir, 'm.txt'), '--config', config], io), 0);
    assert.equal(out[0], await signer.signMessage(message(signer.address)));
    writeFileSync(join(dir, 'other.txt'), message('0x' + '55'.repeat(20)));
    assert.equal(await main(['sign-message', '--file', join(dir, 'other.txt'), '--config', config], io), 1);
    writeFileSync(join(dir, 'tx.txt'), 'Transfer all funds');
    assert.equal(await main(['sign-message', '--file', join(dir, 'tx.txt'), '--config', config], io), 1, 'only association messages');
    assert.ok(!err.join('\n').includes(key.slice(2)));
    assert.throws(() => parseConfig({ ...defaultConfig(), mode: 'autonomous' }), /mode/);
  } finally { delete process.env.FLURBO_AGENT_PRIVATE_KEY; rmSync(dir, { recursive: true, force: true }); }
});
