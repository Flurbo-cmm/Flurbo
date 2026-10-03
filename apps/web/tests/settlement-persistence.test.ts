import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLocalSettlementCommand } from '../server/local-settlement-command.mjs';
import { createSettlementStores, settlementPacketHandler, settlementPublicOrigin, SETTLEMENT_PACKET_PATH } from '../server/settlement-persistence.mjs';
import { settlementLease } from '../server/settlement-store.mjs';
import { pilotEvidence } from '../server/pilot.mjs';
import { canonical, digest, settlementRuleHash } from '../server/settlement-rules.mjs';
import { evaluateSettlement } from '../server/settlement-evidence.mjs';
import { localApi } from '../server/local-api.mjs';

const at = 1800000000, source = 'https://data.example.org/release.json', origin = 'https://evidence.flurbo.dev';
function fixture() {
  const rule = { schema: 'flurbo.settlement-rule.v1', eventId: 'event-1', question: 'Does the first release exceed 4.2 percent?',
    source: { id: 'fixture-source', publisher: 'Fixture Publisher', urls: [source], adapter: 'json-record.v1',
      fields: Object.fromEntries(['id', 'series', 'period', 'unit', 'publishedAt', 'kind', 'value'].map(key => [key, '/' + key])) },
    observation: { series: 'fixture-rate', period: '2026-11', unit: 'percent' }, decision: { type: 'number', operator: 'gt', value: '4.2' },
    timing: { scheduledAt: at - 100, publicationCutoff: at, correctionCutoff: at, observationEndsAt: at, assertionPeriod: 3600, challengePeriod: 3600, votingPeriod: 3600 },
    vintage: 'initial', missingPolicy: 'resolver-timeout-void' };
  const body = JSON.stringify({ id: 'initial-1', ...rule.observation, publishedAt: at - 10, kind: 'initial', value: '4.0' });
  const capture = { requestedUrl: source, finalUrl: source, fetchedAt: at, status: 200, contentType: 'application/json', complete: true,
    body, bytes: Buffer.byteLength(body), sha256: digest(body) };
  const evaluation = evaluateSettlement(rule, [capture], { now: at });
  assert.equal(evaluation.status, 'ready');
  return { rule, capture, evaluation, ruleHash: settlementRuleHash(rule) };
}
async function temporary(t: any) {
  const directory = await mkdtemp(join(tmpdir(), 'flurbo-settlement-store-'));
  t.after(async () => { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); });
  return directory;
}

test('local settlement command preserves real lease and archive semantics across restarts', async t => {
  const directory = await temporary(t); let now = at * 1000;
  const command = await createLocalSettlementCommand({ directory, now: () => now });
  const lease = await settlementLease(command, 'fixture-monitor');
  await lease.save({ pending: 'keep-signed-transaction-before-broadcast' });
  const restarted = await createLocalSettlementCommand({ directory, now: () => now });
  await assert.rejects(settlementLease(restarted, 'fixture-monitor'), /already running/);
  await lease.release();
  const next = await settlementLease(restarted, 'fixture-monitor');
  assert.equal((await next.load()).pending, 'keep-signed-transaction-before-broadcast');
  now += 300001;
  const successor = await settlementLease(command, 'fixture-monitor');
  await assert.rejects(next.save({ pending: 'lost' }), /lease lost/);
  await assert.rejects(next.release(), /lease lost/);
  assert.equal((await successor.load()).pending, 'keep-signed-transaction-before-broadcast');
  await successor.release();
  const archive = pilotEvidence(command, origin, () => now), input = { eventId: 'event-1', outcome: 1,
    statement: 'The immutable source rule evaluates to NO.', sourceURL: source, attachment: '{"fixture":true}' };
  const result = await archive.put(input, '0x' + 'ab'.repeat(20), '0x' + 'cd'.repeat(32));
  assert.equal(await pilotEvidence(restarted, origin).get(result.hash), result.body);
  assert.equal((await archive.put(input, '0x' + 'ab'.repeat(20), '0x' + 'cd'.repeat(32))).hash, result.hash);
});

test('atomic local commands serialize independent processes without lost quota or lease writes', async t => {
  const directory = await temporary(t), module = new URL('../server/local-settlement-command.mjs', import.meta.url).href;
  const script = "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],7200) end; return n";
  const code = `const {createLocalSettlementCommand}=await import(${JSON.stringify(module)}); const c=await createLocalSettlementCommand({directory:process.argv[1]}); for(let i=0;i<15;i++) await c('EVAL',${JSON.stringify(script)},1,'flurbo:pilot:evidence-quota:fixture');`;
  await Promise.all([promisify(execFile)(process.execPath, ['--input-type=module', '-e', code, directory]), promisify(execFile)(process.execPath, ['--input-type=module', '-e', code, directory])]);
  const command = await createLocalSettlementCommand({ directory });
  assert.equal(await command('GET', 'flurbo:pilot:evidence-quota:fixture'), '30');
  const writes = await Promise.all(Array.from({ length: 8 }, (_, i) => command('SET', 'flurbo:monitor:v1:atomic:lock', String(i), 'NX', 'PX', 5000)));
  assert.equal(writes.filter(value => value === 'OK').length, 1);
  await assert.rejects(command('GET', '../../keys.json'), /namespace/);
  await assert.rejects(command('GET', 'flurbo:auth:v1:secret'), /namespace/);
  await assert.rejects(command('EVAL', 'return 1', 1, 'flurbo:monitor:v1:key'), /Unsupported/);
  await assert.rejects(command('SET', 'flurbo:monitor:v1:key', 'x', 'XX'), /option/);
});

test('capture history retains earliest and latest copies, changed facts, attempts and restart state', async t => {
  const directory = await temporary(t), command = await createLocalSettlementCommand({ directory });
  const stores = createSettlementStores({ command, origin, now: () => at + 500 });
  const { capture, ruleHash } = fixture();
  await stores.captureStore.put(ruleHash, capture);
  await stores.captureStore.put(ruleHash, { ...capture, fetchedAt: at + 200 });
  await stores.captureStore.put(ruleHash, { ...capture, fetchedAt: at + 100 });
  assert.deepEqual((await stores.captureStore.list(ruleHash)).map(c => c.fetchedAt), [at, at + 200]);
  const changed = { ...capture, body: capture.body.replace('4.0', '4.5') }; changed.bytes = Buffer.byteLength(changed.body); changed.sha256 = digest(changed.body);
  await stores.captureStore.put(ruleHash, changed);
  assert.equal((await stores.captureStore.list(ruleHash)).length, 3);
  await stores.captureStore.recordAttempt(ruleHash, { at: at + 210, ok: false, issues: ['SOURCE_FETCH_FAILED'] });
  assert.equal(await stores.captureStore.recordAttempt(ruleHash, { at: at + 205, ok: true, issues: [] }), false);
  const restarted = createSettlementStores({ command: await createLocalSettlementCommand({ directory }), origin, now: () => at + 500 });
  assert.equal((await restarted.captureStore.latestAttempt(ruleHash)).ok, false);
  await restarted.captureStore.recordAttempt(ruleHash, { at: at + 220, ok: true, issues: [] });
  assert.equal((await restarted.captureStore.latestAttempt(ruleHash)).ok, true);
  await assert.rejects(stores.captureStore.put(ruleHash, { ...capture, complete: false }), /complete/);
  await assert.rejects(stores.captureStore.put(ruleHash, { ...capture, fetchedAt: at + 501 }), /future/);
  assert.equal((await restarted.captureStore.list(ruleHash)).length, 3);
});

test('packet storage is immutable, content addressed and independently replayed after restart', async t => {
  const directory = await temporary(t), command = await createLocalSettlementCommand({ directory });
  const { evaluation, ruleHash } = fixture(), stores = createSettlementStores({ command, origin, now: () => at });
  const saved = await stores.packetStore.put(evaluation.packet, evaluation.packetHash);
  assert.equal(saved.uri, origin + SETTLEMENT_PACKET_PATH + evaluation.packetHash);
  const restarted = createSettlementStores({ command: await createLocalSettlementCommand({ directory }), origin });
  assert.equal((await restarted.packetStore.get(saved.uri)).outcome, 1);
  await assert.rejects(stores.packetStore.put({ ...evaluation.packet, outcome: 2 }, evaluation.packetHash));
  await assert.rejects(stores.packetStore.get(origin + SETTLEMENT_PACKET_PATH + '../state.json'));
  await assert.rejects(stores.packetStore.get('https://other.example.org' + SETTLEMENT_PACKET_PATH + evaluation.packetHash));
  await assert.rejects(createSettlementStores({ command }).packetStore.put(evaluation.packet, evaluation.packetHash), /origin/);
  const key = 'flurbo:settlement:v1:packet:' + evaluation.packetHash;
  await command('SET', key, canonical({ ...evaluation.packet, ruleHash: '0'.repeat(64) }));
  await assert.rejects(restarted.packetStore.get(saved.uri), /corrupt/);
  await assert.rejects(stores.packetStore.put(evaluation.packet, evaluation.packetHash), /corrupt/);
  await stores.captureStore.put(ruleHash, fixture().capture);
  const data = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  const historyKey = 'flurbo:settlement:v1:captures:' + ruleHash, history = JSON.parse(data.entries[historyKey].value);
  history.entries[0].capture.body = 'tampered'; data.entries[historyKey].value = JSON.stringify(history);
  await writeFile(join(directory, 'state.json'), JSON.stringify(data));
  await assert.rejects(restarted.captureStore.list(ruleHash), /capture|integrity/i);
});

test('capture limits fail closed without evicting source history or resetting invalid state', async t => {
  const directory = await temporary(t), command = await createLocalSettlementCommand({ directory });
  const { capture, ruleHash } = fixture(), { captureStore } = createSettlementStores({ command, now: () => at });
  for (let i = 0; i < 50; i++) {
    const body = JSON.stringify({ ...JSON.parse(capture.body), version: i });
    await captureStore.put(ruleHash, { ...capture, body, bytes: Buffer.byteLength(body), sha256: digest(body) });
  }
  await assert.rejects(captureStore.put(ruleHash, capture), /capacity/);
  assert.equal((await captureStore.list(ruleHash)).length, 50);
  await assert.rejects(captureStore.put(ruleHash, { ...capture, body: 'x'.repeat(2_000_001) }), /capture/);
  await command('SET', 'flurbo:monitor:v1:retained:state', 'keep-pending');
  const previous = await readFile(join(directory, 'state.json'), 'utf8');
  await assert.rejects(command('SET', 'flurbo:monitor:v1:too-large', 'x'.repeat(16_000_001)), /bounded/);
  assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), previous);
  await writeFile(join(directory, 'state.json'), '{invalid');
  await assert.rejects(command('GET', 'flurbo:monitor:v1:retained:state'));
  assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), '{invalid');
});

test('public packet verification rejects unavailable, partial, oversized and tampered responses', async t => {
  const directory = await temporary(t), command = await createLocalSettlementCommand({ directory });
  const { evaluation } = fixture(), { packetStore } = createSettlementStores({ command, origin });
  const saved = await packetStore.put(evaluation.packet, evaluation.packetHash), body = canonical(evaluation.packet);
  const request = (content: any, options = {}) => async () => new Response(content, { headers: { 'Content-Type': 'application/json' }, ...options });
  assert.equal((await packetStore.verifyPublic(saved.uri, { request: request(body) })).outcome, 1);
  await assert.rejects(packetStore.verifyPublic(saved.uri, { request: request(body.replace('initial-1', 'different')) }));
  await assert.rejects(packetStore.verifyPublic(saved.uri, { request: request(body, { status: 404 }) }));
  await assert.rejects(packetStore.verifyPublic(saved.uri, { request: request(body, { headers: { 'Content-Type': 'application/json', 'Content-Range': 'bytes 0-10/30' } }) }));
  await assert.rejects(packetStore.verifyPublic(saved.uri, { request: request(body, { headers: { 'Content-Type': 'application/json', 'Content-Length': String(body.length + 1) } }) }));
  await assert.rejects(packetStore.verifyPublic(saved.uri, { request: request(new Uint8Array(16_000_001)) }), /large/);
});

test('packet route is public read-only under invite gating and rejects noncanonical paths', async t => {
  const directory = await temporary(t), command = await createLocalSettlementCommand({ directory });
  const { evaluation } = fixture(), { packetStore } = createSettlementStores({ command, origin });
  const saved = await packetStore.put(evaluation.packet, evaluation.packetHash);
  let handler: any;
  const server = createServer((req, res) => handler(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => server.close(() => done())));
  const address: any = server.address(), host = '127.0.0.1:' + address.port;
  handler = localApi({ hosts: [host], settlementPackets: packetStore, previewAccess: { allows: async () => false } });
  const path = SETTLEMENT_PACKET_PATH + saved.sha256, base = 'http://' + host;
  const response = await fetch(base + path, { headers: { Origin: 'https://outside.example.org', 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(response.status, 200); assert.equal(await response.text(), canonical(evaluation.packet));
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal((await fetch(base + path, { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(base + path, { method: 'POST' })).status, 405);
  for (const suffix of ['?download=1', '/extra', '%2f..%2fstate.json']) assert.equal((await fetch(base + path + suffix)).status, 404);
  assert.equal((await fetch(base + '/api/practice-collections')).status, 401);
});

test('public evidence origin refuses loopback, local names and credential-bearing URLs', () => {
  assert.equal(settlementPublicOrigin(origin), origin);
  for (const value of ['http://localhost:18868', 'https://localhost', 'https://127.0.0.1', 'https://[::1]', 'https://evidence.local', 'https://secret@public.host', origin + '/path']) {
    assert.throws(() => settlementPublicOrigin(value), /origin/);
  }
  assert.equal(typeof settlementPacketHandler, 'function');
});
