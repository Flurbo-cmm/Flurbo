import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createLocalSettlementCommand } from '../server/local-settlement-command.mjs';
import { createSettlementStores } from '../server/settlement-persistence.mjs';
import { MAX_PROOF_SUBMISSION_BYTES, PROOF_CAPTURE_PATH, proofCaptureRules, proofCaptureService } from '../server/proof-captures.mjs';
import { localApi } from '../server/local-api.mjs';
import { settlementRuleHash } from '../server/settlement-rules.mjs';
import { OTHER_KEY, T0, proofCapture, proofRule } from './proof-fixture.ts';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789-_ABCDEFG';
const origin = 'https://evidence.flurbo.dev';
async function setup(t: any, clock = T0 + 600) {
  const directory = await mkdtemp(join(tmpdir(), 'flurbo-proof-captures-'));
  t.after(async () => { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); });
  const command = await createLocalSettlementCommand({ directory }), { captureStore } = createSettlementStores({ command, origin, now: () => T0 + 600 });
  const rule = proofRule(), ruleHash = settlementRuleHash(rule);
  const service = proofCaptureService({ rules: new Map([[ruleHash, rule]]), captureStore, token: TOKEN, now: () => clock });
  const submit = (body: any, authorization = `Bearer ${TOKEN}`) => service.submit({ authorization, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { rule, ruleHash, captureStore, service, submit };
}

test('a valid proof capture is stored under its rule hash', async t => {
  const { rule, ruleHash, captureStore, service, submit } = await setup(t), capture = await proofCapture(rule);
  assert.equal(service.size, 1);
  assert.deepEqual(await submit({ ruleHash, capture }), { status: 200, body: { status: 'stored', ruleHash, firstFetchedAt: T0 + 60, latestFetchedAt: T0 + 60 } });
  const kept = await captureStore.list(ruleHash);
  assert.equal(kept.length, 1); assert.equal(kept[0].sha256, capture.sha256);
  assert.equal((await submit({ ruleHash, capture })).status, 200);
  assert.equal((await captureStore.list(ruleHash)).length, 1);
  const later = await proofCapture(rule, { timestampS: T0 + 120, extracted: { matchId: '123', status: 'FINISHED', winner: 'AWAY_TEAM', homeGoals: '0', awayGoals: '1' } });
  assert.equal((await submit({ ruleHash, capture: later })).status, 200);
  assert.deepEqual((await captureStore.list(ruleHash)).map((c: any) => c.fetchedAt), [T0 + 60, T0 + 120]);
});

test('wrong or missing tokens are refused', async t => {
  const { ruleHash, rule, captureStore, submit } = await setup(t), capture = await proofCapture(rule);
  assert.deepEqual(await submit({ ruleHash, capture }, 'Bearer ' + 'w'.repeat(43)), { status: 401, body: { error: 'Proof submission unauthorized' } });
  assert.equal((await submit({ ruleHash, capture }, '')).status, 401);
  assert.equal((await submit({ ruleHash, capture }, TOKEN)).status, 401);
  assert.equal((await captureStore.list(ruleHash)).length, 0);
  for (const token of ['short-token', 'a'.repeat(129), 'has spaces ' + 'a'.repeat(30), '']) {
    assert.throws(() => proofCaptureService({ rules: new Map(), captureStore, token }), /Proof submission token must be 32 to 128 URL-safe characters/);
  }
});

test('only listed proof rules accept captures', async t => {
  const { rule, ruleHash, submit } = await setup(t), capture = await proofCapture(rule);
  assert.deepEqual(await submit({ ruleHash: 'ee'.repeat(32), capture }), { status: 404, body: { error: 'Rule not accepting proofs' } });
  const hybrid = JSON.parse(await readFile(new URL('../../../config/hybrid-markets.json', import.meta.url), 'utf8'));
  const proofPool = { prepared: { draft: { events: [{ rule: hybrid.pools[0].prepared.draft.events[0].rule }, { rule }] } } };
  const listed = proofCaptureRules([...hybrid.pools, proofPool]);
  assert.deepEqual([...listed.keys()], [ruleHash]);
  assert.equal(listed.get(ruleHash).source.adapter, 'proof-http.v1');
  assert.equal(proofCaptureRules([]).size, 0);
  assert.equal(proofCaptureRules([{ prepared: { draft: { events: [{ route: 'reality' }] } } }]).size, 0);
});

test('invalid proofs are rejected with their reason', async t => {
  const { rule, ruleHash, captureStore, submit } = await setup(t);
  assert.deepEqual(await submit({ ruleHash, capture: await proofCapture(rule, { keys: [OTHER_KEY] }) }),
    { status: 422, body: { error: 'Proof capture rejected', reason: 'PROOF_SIGNATURE_INVALID' } });
  assert.equal((await submit({ ruleHash, capture: await proofCapture(rule, { timestampS: T0 - 5 }) })).body.reason, 'PROOF_OUTSIDE_WINDOW');
  assert.equal((await submit({ ruleHash, capture: await proofCapture(rule, { timestampS: T0 + 700 }) })).body.reason, 'CAPTURE_TIME_INVALID');
  assert.equal((await submit({ ruleHash, capture: await proofCapture(rule, { extracted: { matchId: '123', status: 'IN_PLAY', winner: 'HOME_TEAM', homeGoals: '0', awayGoals: '0' } }) })).body.reason, 'OBSERVATION_IDENTITY_MISMATCH');
  assert.deepEqual(await submit('{not json'), { status: 400, body: { error: 'Invalid proof submission' } });
  for (const body of [{ ruleHash: 'XYZ', capture: {} }, { ruleHash, capture: 'text' }, { ruleHash, capture: [] }, { capture: {} }, [], 'null'])
    assert.equal((await submit(body)).status, 400);
  assert.equal((await submit('x'.repeat(MAX_PROOF_SUBMISSION_BYTES + 1))).status, 413);
  assert.equal((await captureStore.list(ruleHash)).length, 0);
  const closed = await setup(t, rule.timing.observationEndsAt + 1);
  assert.deepEqual(await closed.submit({ ruleHash, capture: await proofCapture(rule) }), { status: 409, body: { error: 'Capture window closed' } });
  assert.equal((await closed.captureStore.list(ruleHash)).length, 0);
});

test('the upload route is POST only, size limited and disabled without a service', async t => {
  const { rule, ruleHash, captureStore, service } = await setup(t), capture = await proofCapture(rule);
  let handler: any;
  const server = createServer((req, res) => handler(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => server.close(() => done())));
  const host = '127.0.0.1:' + (server.address() as any).port, base = 'http://' + host, post = (body: string, authorization = `Bearer ${TOKEN}`) =>
    fetch(base + PROOF_CAPTURE_PATH, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body });
  handler = localApi({ hosts: [host], previewAccess: { allows: async () => false } });
  assert.equal((await post('{}')).status, 404);
  handler = localApi({ hosts: [host], proofCaptures: service, previewAccess: { allows: async () => false } });
  assert.equal((await fetch(base + PROOF_CAPTURE_PATH)).status, 405);
  assert.equal((await post(JSON.stringify({ ruleHash, capture }), 'Bearer nope')).status, 401);
  const stored = await post(JSON.stringify({ ruleHash, capture }));
  assert.equal(stored.status, 200); assert.equal((await stored.json()).status, 'stored');
  assert.equal((await captureStore.list(ruleHash)).length, 1);
  assert.equal((await post('x'.repeat(MAX_PROOF_SUBMISSION_BYTES + 10))).status, 413);
  assert.equal(PROOF_CAPTURE_PATH, '/api/settlement/proof-captures');
});
