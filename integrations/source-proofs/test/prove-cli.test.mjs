import test from 'node:test';
import assert from 'node:assert/strict';
import { settlementRuleHash } from '../../../apps/web/server/settlement-rules.mjs';
import { main } from '../prove.mjs';
import { EXTRACTED, T0, TOKEN, fakeClient, rule, wallet } from './proof-helpers.mjs';

const SECRETS = { FLURBO_RECLAIM_APP_ID: 'app-id-aaaaaaaa', FLURBO_RECLAIM_APP_SECRET: 'app-secret-bbbbbbbb',
  FLURBO_PROOF_CREDENTIAL_FOOTBALL_DATA: TOKEN, FLURBO_PROOF_SUBMIT_TOKEN: 'submit-token-cccccccccccccccccccccccccc' };
const catalog = (subject = rule()) => ({ schema: 'flurbo.hybrid-catalog.v1', pools: [{ id: 'hybrid-proof-1', prepared: { draft: { events: [{ rule: subject }, { rule: subject }] } } }] });

async function run(argv, { files = {}, env = SECRETS, calls = [], client = {}, clock = T0 + 120, requests = [], reply = { status: 200, body: null } } = {}) {
  const out = [], err = [], saved = {}, sleeps = [];
  let now = clock;
  const request = async (url, init) => {
    requests.push({ url, init });
    const body = reply.body ?? (() => { const sent = JSON.parse(init.body); return { status: 'stored', ruleHash: sent.ruleHash, firstFetchedAt: sent.capture.fetchedAt, latestFetchedAt: sent.capture.fetchedAt }; })();
    return { status: reply.status, json: async () => body };
  };
  const code = await main(argv, { env, clientClass: fakeClient(calls, client), request, now: () => now,
    sleep: async ms => { sleeps.push(ms); now += ms / 1000; }, print: line => out.push(JSON.parse(line)), error: line => err.push(line),
    readJson: async file => { if (!(file in files)) throw Error('missing file'); return files[file]; }, save: async (file, text) => { saved[file] = text; } });
  return { code, out, err, saved, sleeps, calls, requests };
}
const never = (result, ...secrets) => {
  const text = JSON.stringify([result.out, result.err, result.sleeps]);
  for (const secret of secrets) assert.equal(text.includes(secret), false, `printed ${secret.slice(0, 6)}...`);
};

test('usage errors exit 1 and name missing environment variables without values', async () => {
  assert.equal((await run([])).code, 1);
  const files = { 'r.json': rule(), 'c.json': catalog() };
  const noEnv = await run(['--rule', 'r.json'], { files, env: { FLURBO_RECLAIM_APP_ID: 'x' } });
  assert.equal(noEnv.code, 1); assert.equal(noEnv.out[0].status, 'missing_environment');
  assert.deepEqual(noEnv.out[0].names, ['FLURBO_RECLAIM_APP_SECRET', 'FLURBO_PROOF_CREDENTIAL_FOOTBALL_DATA']);
  for (const argv of [['--catalog', 'c.json', '--pool', 'nope', '--event', '0'], ['--catalog', 'c.json', '--pool', 'hybrid-proof-1', '--event', '9'],
    ['--catalog', 'c.json', '--pool', 'hybrid-proof-1', '--event', '0', '--discover'], ['--rule', 'r.json', '--submit', 'https://flurbopm.singu.online'],
    ['--rule', 'r.json', '--mode', 'other'], ['--rule', 'r.json', '--index', '4'], ['--rule', 'r.json', '--surprise'], ['--rule', 'missing.json'], ['--rule']])
    assert.equal((await run(argv, { files })).code, 1, argv.join(' '));
  const invalid = rule(); invalid.source.adapter = 'json-api.v1';
  const bad = await run(['--rule', 'r.json'], { files: { 'r.json': invalid } });
  assert.equal(bad.code, 1); assert.equal(bad.out[0].status, 'invalid');
  const noToken = await run(['--catalog', 'c.json', '--pool', 'hybrid-proof-1', '--event', '0', '--submit', 'https://flurbopm.singu.online'],
    { files, env: { ...SECRETS, FLURBO_PROOF_SUBMIT_TOKEN: undefined } });
  assert.equal(noToken.code, 1); assert.deepEqual(noToken.out[0].names, ['FLURBO_PROOF_SUBMIT_TOKEN']);
  assert.equal(noToken.calls.length, 0);
});

test('rule mode proves outside the window, writes the capture and never prints a secret', async () => {
  const subject = rule(), files = { 'r.json': [subject, rule()] };
  const result = await run(['--rule', 'r.json', '--out', 'out.json'], { files, clock: T0 - 5000, client: { timestampS: T0 - 5100 } });
  assert.equal(result.code, 0);
  assert.deepEqual(result.out, [{ status: 'proved', ruleHash: settlementRuleHash(subject), signedAt: new Date((T0 - 5100) * 1000).toISOString().replace('.000Z', 'Z'), value: 'HOME_TEAM' }]);
  const saved = JSON.parse(result.saved['out.json']);
  assert.equal(saved.requestedUrl, subject.source.urls[0]);
  assert.equal(JSON.parse(saved.body).proof.claimData.provider, 'http');
  assert.equal(result.requests.length, 0);
  assert.equal(result.calls[0].appId, SECRETS.FLURBO_RECLAIM_APP_ID);
  never(result, TOKEN, SECRETS.FLURBO_RECLAIM_APP_SECRET, SECRETS.FLURBO_RECLAIM_APP_ID, SECRETS.FLURBO_PROOF_SUBMIT_TOKEN);
});

test('discover mode reports the signer without needing the attestor pin', async () => {
  const placeholder = rule(undefined, '0x' + '0'.repeat(39) + '1'), files = { 'r.json': placeholder };
  const pinned = await run(['--rule', 'r.json'], { files });
  assert.equal(pinned.code, 5); assert.equal(pinned.out[0].reason, 'PROOF_SIGNATURE_INVALID');
  const found = await run(['--rule', 'r.json', '--discover', '--out', 'discovery.json'], { files });
  assert.equal(found.code, 0); assert.deepEqual(found.out, [{ status: 'discovered', signers: [wallet.address.toLowerCase()] }]);
  assert.ok(found.saved['discovery.json']);
});

test('catalog mode honors the capture window', async () => {
  const files = { 'c.json': catalog() }, argv = ['--catalog', 'c.json', '--pool', 'hybrid-proof-1', '--event', '1'];
  for (const clock of [T0 - 1, T0 + 6 * 3600 + 1]) {
    const result = await run(argv, { files, clock });
    assert.equal(result.code, 4); assert.equal(result.calls.length, 0);
  }
});

test('a verified proof is submitted and reported as stored', async () => {
  const files = { 'c.json': catalog() }, argv = ['--catalog', 'c.json', '--pool', 'hybrid-proof-1', '--event', '0', '--submit', 'https://flurbopm.singu.online'];
  const result = await run(argv, { files });
  assert.equal(result.code, 0);
  assert.deepEqual(result.out, [{ status: 'stored', ruleHash: settlementRuleHash(rule()), signedAt: new Date((T0 + 60) * 1000).toISOString().replace('.000Z', 'Z'), value: 'HOME_TEAM', firstFetchedAt: T0 + 60 }]);
  assert.equal(result.requests[0].url, 'https://flurbopm.singu.online/api/settlement/proof-captures');
  assert.equal(result.requests[0].init.headers.authorization, `Bearer ${SECRETS.FLURBO_PROOF_SUBMIT_TOKEN}`);
  never(result, TOKEN, SECRETS.FLURBO_RECLAIM_APP_SECRET, SECRETS.FLURBO_PROOF_SUBMIT_TOKEN);
  const local = await run(argv.slice(0, 6), { files });
  assert.equal(local.code, 0); assert.equal(local.out[0].status, 'proved'); assert.equal(local.requests.length, 0);
});

test('failures map to distinct exit codes and an unverified proof is never submitted', async () => {
  const files = { 'c.json': catalog() }, argv = ['--catalog', 'c.json', '--pool', 'hybrid-proof-1', '--event', '0', '--submit', 'https://flurbopm.singu.online'];
  const rejected = await run(argv, { files, reply: { status: 422, body: { error: 'Proof capture rejected', reason: 'PROOF_SIGNATURE_INVALID' } } });
  assert.equal(rejected.code, 6); assert.match(rejected.out[0].message, /422 PROOF_SIGNATURE_INVALID/);
  const unfinished = await run(argv, { files, client: { extracted: { ...EXTRACTED, status: 'IN_PLAY' } } });
  assert.equal(unfinished.code, 5); assert.equal(unfinished.out[0].reason, 'OBSERVATION_IDENTITY_MISMATCH'); assert.equal(unfinished.requests.length, 0);
  const broken = await run(argv, { files, client: { fail: `upstream said ${TOKEN} and ${SECRETS.FLURBO_RECLAIM_APP_SECRET}` } });
  assert.equal(broken.code, 3); assert.equal(broken.out[0].status, 'failed');
  never(broken, TOKEN, SECRETS.FLURBO_RECLAIM_APP_SECRET);
  assert.match(JSON.stringify(broken.out), /\[hidden\]/);
});

test('watch retries every ten minutes until a proof is stored or the window closes', async () => {
  const files = { 'c.json': catalog() }, argv = ['--catalog', 'c.json', '--pool', 'hybrid-proof-1', '--event', '0', '--submit', 'https://flurbopm.singu.online', '--watch'];
  const finishes = await run(argv, { files, clock: T0 - 1200, client: { timestampS: T0, extracted: n => (n < 3 ? { ...EXTRACTED, status: 'IN_PLAY' } : EXTRACTED) } });
  assert.equal(finishes.code, 0);
  assert.deepEqual(finishes.sleeps, [600_000, 600_000, 600_000, 600_000]);
  assert.deepEqual(finishes.out.map(line => line.status), ['failed', 'failed', 'stored']);
  assert.equal(finishes.requests.length, 1);
  const closes = await run(argv, { files, clock: T0 + 6 * 3600 - 100, client: { timestampS: T0 + 6 * 3600 - 200, extracted: { ...EXTRACTED, status: 'IN_PLAY' } } });
  assert.equal(closes.code, 4); assert.equal(closes.out.at(-1).status, 'window_closed'); assert.equal(closes.requests.length, 0);
});
