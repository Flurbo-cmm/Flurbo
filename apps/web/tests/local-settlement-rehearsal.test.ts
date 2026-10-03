import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rehearsalConfig, rehearsalEnvironment, localAlertSink, createRehearsalCycle, writeRehearsalJson } from '../server/local-settlement-rehearsal.mjs';
import { localStateDirectory, loadLocalRehearsal } from '../scripts/run-local-settlement-rehearsal.mjs';
import { evidenceGateway } from '../scripts/serve-settlement-evidence.mjs';
import { createLocalSettlementCommand } from '../server/local-settlement-command.mjs';
import { pilotFixture, hash } from './pilot-fixture.ts';
import { settlementEvent, settlementBindings, pilotRulesHash } from '../server/settlement-publication.mjs';
import { monitorIdentity } from '../server/settlement-monitor.mjs';
import { requireHealthyMonitor } from '../server/resolution-worker.mjs';
import { settlementLease } from '../server/settlement-store.mjs';

const origin = 'https://rehearsal.public-host.dev', signer = '0x' + 'aa'.repeat(20), time = 1800000000;
function fixture() {
  const base = pilotFixture(time, 2), publication = base.manifest.publication;
  publication.schema = 'flurbo.pilot-publication.v1'; publication.mode = 'deterministic-source-v1'; publication.rulesReviewed = true;
  publication.settlementRules = [0, 1].map(bit => ({ schema: 'flurbo.settlement-rule.v1', eventId: `source-${bit}`, question: `Does measured quantity ${bit} exceed its threshold?`,
    source: { id: `source-${bit}`, publisher: 'Synthetic test publisher', urls: [`https://data.example.org/${bit}.json`], adapter: 'json-record.v1',
      fields: Object.fromEntries(['id', 'series', 'period', 'unit', 'publishedAt', 'kind', 'value'].map(key => [key, '/' + key])) },
    observation: { series: `series-${bit}`, period: '2026-11', unit: 'units' }, decision: { type: 'number', operator: 'gt', value: '4.2' },
    timing: { scheduledAt: time + 100, publicationCutoff: time + 300, correctionCutoff: time + 300, observationEndsAt: time + 300,
      assertionPeriod: 3600, challengePeriod: 3600, votingPeriod: 3600 }, vintage: 'initial', missingPolicy: 'resolver-timeout-void' }));
  publication.draft = { schema: 'flurbo.event-draft.v1', status: 'draft', chainId: 10143, clusterId: 'rehearsal-test', title: 'Isolated test collection',
    closesAt: time + 50, events: publication.settlementRules.map(settlementEvent), exceptionPolicy: 'Fixed VOID timeout.',
    disputeModel: 'bonded', disputePolicy: 'Named reviewers decide disputes.' };
  const bindings = settlementBindings(publication);
  base.manifest.draftHash = bindings.draftHash; base.manifest.configHash = bindings.configHash;
  base.manifest.rulesHash = pilotRulesHash(bindings.config, base.manifest.resolver, publication.creator);
  const config = rehearsalConfig({ schema: 'flurbo.local-settlement-rehearsal.v1', manifestPath: 'target/test-manifest.json',
    stateDirectory: 'target/local-settlement-rehearsal/test', signerAddress: signer, pool: base.manifest.pool,
    rulesHash: base.manifest.rulesHash, evidenceOrigin: origin });
  return { ...base, config };
}
async function temporary(t: any) {
  const directory = await mkdtemp(join(tmpdir(), 'flurbo-local-rehearsal-'));
  t.after(async () => { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); });
  return directory;
}
function observation(manifest: any) {
  return { report: { schema: 'flurbo.settlement-monitor.v1', checkedAt: time, pool: manifest.pool, resolver: manifest.resolver,
    status: 'attention_required', lifecycle: 'trading_open', snapshot: { blockNumber: '100', blockHash: hash, timestamp: time },
    alerts: [{ code: 'FIXTURE_REVIEW', severity: 'warning', message: 'Review the source rule fixture.' }], events: [] },
    checkpoint: { schema: 'flurbo.settlement-checkpoint.v1', identity: monitorIdentity(manifest), checkedAt: time,
      snapshot: { blockNumber: '100', blockHash: hash, timestamp: time }, delivered: false,
      cases: manifest.publication.draft.events.map(() => ({ phase: 0, result: 0, votes: [0, 0, 0] })) } };
}

test('rehearsal configuration refuses production leakage, non-testnet RPC and signer role conflicts', () => {
  const { config, manifest } = fixture();
  const env = rehearsalEnvironment(config, manifest, { execute: false, privateKey: 'must-not-be-forwarded' });
  assert.equal(env.FLURBO_RESOLUTION_EXECUTE, 'false'); assert.equal(env.FLURBO_RESOLUTION_PROPOSALS, 'true');
  assert.equal(env.FLURBO_RESOLUTION_POOL, manifest.pool); assert.equal(env.FLURBO_RESOLUTION_PRIVATE_KEY, undefined);
  for (const name of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'FLURBO_RESOLUTION_COLLECTIONS_JSON', 'FLURBO_RESOLUTION_FINISH_ALLOWLIST']) assert.equal(env[name], undefined);
  assert.equal(rehearsalEnvironment(config, manifest, { execute: true, privateKey: 'test-key' }).FLURBO_RESOLUTION_PRIVATE_KEY, 'test-key');
  assert.throws(() => rehearsalEnvironment(config, manifest, { execute: true }), /signing key/);
  assert.throws(() => rehearsalEnvironment(config, manifest, { execute: 'false' as any }), /boolean/);
  for (const address of [manifest.pool, manifest.resolver, manifest.publication.creator, manifest.publication.reviewers[0].address]) {
    assert.throws(() => rehearsalEnvironment({ ...config, signerAddress: address }, manifest), /separate/);
  }
  for (const rpcUrl of ['https://rpc.monad.xyz', 'http://127.0.0.1:8545', 'https://user:secret@testnet-rpc.monad.xyz']) assert.throws(() => rehearsalConfig({ ...config, rpcUrl }));
  for (const extra of [{ privateKey: 'secret' }, { UPSTASH_REDIS_REST_TOKEN: 'secret' }, { port: 80 }, { intervalSeconds: 1 }, { evidenceOrigin: 'http://localhost:18868' }]) assert.throws(() => rehearsalConfig({ ...config, ...extra }));
});

test('selected pool, rules, chain and deterministic mode remain exact launch boundaries', () => {
  const { config, manifest } = fixture();
  for (const altered of [{ ...manifest, chainId: 143 }, { ...manifest, pool: '0x' + 'bb'.repeat(20) }, { ...manifest, rulesHash: '0x' + 'cc'.repeat(32) },
    { ...manifest, publication: { ...manifest.publication, mode: 'rehearsal' } }]) assert.throws(() => rehearsalEnvironment(config, altered), /selected/);
  for (const path of ['target/local-settlement-rehearsal', 'target/local-settlement-rehearsal/../production', '.', 'config', resolve(tmpdir())]) assert.throws(() => localStateDirectory(path), /separate directory/);
  assert.ok(localStateDirectory('target/local-settlement-rehearsal/test-run').endsWith(join('local-settlement-rehearsal', 'test-run')));
});

test('monitor snapshot and durable alert acceptance precede worker with healthy persisted gate', async t => {
  const { config, manifest } = fixture(), directory = await temporary(t), command = await createLocalSettlementCommand({ directory: join(directory, 'store') });
  const sink = await localAlertSink(directory), order: string[] = [];
  const cycle = createRehearsalCycle({ config, manifest, command, now: () => time, rpc: async () => { throw Error('Unexpected RPC'); },
    inspect: async () => { order.push('monitor'); return observation(manifest); },
    send: async item => { order.push('alert'); return sink(item); },
    workerDependencies: { command: async () => { throw Error('Injected foreign store must not win'); } },
    run: async (env, deps) => { order.push('worker'); assert.equal(env.FLURBO_RESOLUTION_POOL, config.pool); await requireHealthyMonitor(deps.command, manifest, time); return { status: 'wait' }; } });
  const report = await cycle();
  assert.deepEqual(order, ['monitor', 'alert', 'worker']); assert.equal(report.monitoring.channel, 'local-file');
  assert.equal(report.monitoring.acceptedAlerts, 1); assert.equal(report.worker.status, 'wait');
  const files = await readdir(join(directory, 'alerts')); assert.equal(files.length, 1);
  assert.equal(JSON.parse(await readFile(join(directory, 'alerts', files[0]), 'utf8')).channel, 'local-file');
  order.length = 0; await cycle(); assert.deepEqual(order, ['monitor', 'worker']);
});

test('failed monitor or undelivered alerts block worker and retain retry state', async t => {
  const { config, manifest } = fixture(), directory = await temporary(t), command = await createLocalSettlementCommand({ directory: join(directory, 'store') });
  const sink = await localAlertSink(directory); let runs = 0;
  const common = { config, manifest, command, now: () => time, rpc: async () => { throw Error('Unexpected RPC'); }, run: async () => { runs++; return { status: 'wait' }; } };
  const failed = createRehearsalCycle({ ...common, inspect: async () => { throw Error('Private upstream failure'); }, send: sink });
  const report = await failed(); assert.equal(report.worker.status, 'monitoring-blocked'); assert.equal(runs, 0);
  assert.equal(JSON.stringify(report).includes('Private upstream failure'), false);
  const offline = createRehearsalCycle({ ...common, inspect: async () => observation(manifest), send: async () => { throw Error('Disk unavailable'); } });
  await assert.rejects(offline(), /Disk unavailable/); assert.equal(runs, 0);
  const lease = await settlementLease(command, monitorIdentity(manifest));
  const queued = await lease.load(); assert.equal(queued.queue.length, 1); await lease.release();
  const restartedCommand = await createLocalSettlementCommand({ directory: join(directory, 'store') });
  const recovered = createRehearsalCycle({ ...common, command: restartedCommand, inspect: async () => observation(manifest), send: sink });
  assert.equal((await recovered()).worker.status, 'wait'); assert.equal(runs, 1);
  const recoveredLease = await settlementLease(restartedCommand, monitorIdentity(manifest));
  const saved = await recoveredLease.load(); assert.equal(saved.queue.length, 0); assert.equal(saved.lastAccepted.key, queued.queue[0].key); await recoveredLease.release();
});

test('local alert files are atomically idempotent under concurrent retries and reject identity changes', async t => {
  const directory = await temporary(t), sink = await localAlertSink(directory);
  const item = { key: 'flurbo-' + randomUUID(), body: { from: 'monitor@rehearsal.invalid', to: ['operator@rehearsal.invalid'], subject: 'Monitor', text: 'Review source settlement evidence.' } };
  const values = await Promise.all(Array.from({ length: 8 }, () => sink(item)));
  assert.equal(new Set(values).size, 1); assert.match(values[0], /^local-file-/);
  assert.equal((await readdir(join(directory, 'alerts'))).length, 1);
  assert.equal(await (await localAlertSink(directory))(item), values[0]);
  await assert.rejects(sink({ ...item, body: { ...item.body, text: 'Changed content under an old key.' } }), /identity mismatch/);
  await assert.rejects(sink({ ...item, key: '../secret' }), /Invalid/);
  await assert.rejects(sink({ ...item, body: { ...item.body, extra: 'x'.repeat(200001) } }), /large/);
});

test('worker failures remain sanitized and standalone JSON writes preserve valid snapshots', async t => {
  const { config, manifest } = fixture(), directory = await temporary(t), command = await createLocalSettlementCommand({ directory: join(directory, 'store') });
  const cycle = createRehearsalCycle({ config, manifest, command, now: () => time, inspect: async () => observation(manifest),
    rpc: async () => { throw Error('Unused'); }, send: await localAlertSink(directory), run: async () => { throw Error('secret-key-never-print'); } });
  const report = await cycle(); assert.equal(report.worker.status, 'resolution_stopped'); assert.equal(JSON.stringify(report).includes('secret-key-never-print'), false);
  const path = join(directory, 'latest.json'); await writeRehearsalJson(path, report);
  await assert.rejects(writeRehearsalJson(path, { invalid: 1n }));
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), report);
  assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false);
});

test('evidence gateway has a minimal read-only surface without app, state or secrets routes', async t => {
  const archiveHash = '0x' + 'ab'.repeat(32), packetHash = 'cd'.repeat(32); let archiveReads = 0, packetReads = 0;
  const body = JSON.stringify({ schema: 'flurbo.pilot-evidence.v1', statement: 'Public fixture only.' });
  const server = evidenceGateway({ archive: { get: async supplied => { archiveReads++; assert.equal(supplied, archiveHash); return body; } },
    packetStore: { getByHash: async supplied => { packetReads++; assert.equal(supplied, packetHash); return { fixture: 'public-packet' }; } } });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); t.after(() => new Promise<void>(done => server.close(() => done())));
  const address: any = server.address(), base = 'http://127.0.0.1:' + address.port;
  for (const path of ['/healthz', '/api/pilot/evidence/' + archiveHash, '/api/settlement/packets/' + packetHash]) {
    const response = await fetch(base + path, { headers: { Authorization: 'secret-not-returned', Cookie: 'flurbo_session=private' } });
    assert.equal(response.status, 200); assert.equal((await response.text()).includes('secret-not-returned'), false);
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff'); assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  }
  for (const path of ['/api/auth/session', '/api/pilot/evidence/' + archiveHash + '?download=true', '/api/settlement/packets/../state.json', '/state.json', '/alerts', '/latest.json', '/config', '/.env', '/api/agent-runtime/profile']) assert.equal((await fetch(base + path)).status, 404);
  assert.equal((await fetch(base + '/api/pilot/evidence/' + archiveHash, { method: 'POST', body: 'overwrite' })).status, 405);
  assert.equal(await (await fetch(base + '/api/pilot/evidence/' + archiveHash, { method: 'HEAD' })).text(), '');
  assert.equal(archiveReads, 2); assert.equal(packetReads, 1);
});

test('rehearsal config loading reads only explicit files and rejects unexpected secrets', async t => {
  const directory = await temporary(t), { config, manifest } = fixture();
  const manifestPath = join(directory, 'manifest.json'), configPath = join(directory, 'config.json');
  await writeRehearsalJson(manifestPath, manifest); await writeRehearsalJson(configPath, { ...config, manifestPath });
  const loaded = await loadLocalRehearsal(configPath); assert.deepEqual(loaded.manifest, manifest);
  assert.equal(loaded.config.evidenceOrigin, origin);
  await writeRehearsalJson(manifestPath, { ...manifest, pool: '0x' + 'bb'.repeat(20) });
  await assert.rejects(loadLocalRehearsal(configPath), /selected/);
  await writeRehearsalJson(manifestPath, manifest);
  await writeRehearsalJson(configPath, { ...config, manifestPath, privateKey: 'do-not-load' });
  await assert.rejects(loadLocalRehearsal(configPath), /configuration/);
});
