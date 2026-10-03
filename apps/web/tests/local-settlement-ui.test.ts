import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFunctionData, encodeFunctionResult } from 'viem';
import { localRehearsalBoundary, rehearsalDisplayCache } from '../scripts/serve-local-settlement-rehearsal.mjs';
import { configureLocalRehearsal, persistLocalRehearsalConfig } from '../scripts/configure-local-settlement-rehearsal.mjs';
import { rehearsalConfig } from '../server/local-settlement-rehearsal.mjs';
import { TESTNET } from '../server/network.mjs';
import { pilotPoolAbi, resolverAbi } from '../shared/pilot.mjs';
import { pilotFixture } from './pilot-fixture.ts';
import { deterministicManifest } from './deterministic-fixture.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const signer = '0x' + 'aa'.repeat(20), port = 18867;
const bootstrap = { schema: 'flurbo.rehearsal-bootstrap.v1', signerAddress: signer,
  stateDirectory: 'target/local-settlement-rehearsal/offline-config-test', evidenceOrigin: 'https://rehearsal.public-host.dev', port, intervalSeconds: 60 };
const cas = "local current=redis.call('GET',KEYS[1]); if (current or '')~=ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); return 1";

async function temporary(t: any) {
  const directory = await mkdtemp(join(tmpdir(), 'flurbo-rehearsal-ui-'));
  t.after(async () => { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); });
  return directory;
}

async function request(boundary: any, url: string, { host = `localhost:${port}`, method = 'GET', ...headers }: any = {}) {
  const response: any = { passed: false };
  await boundary({ url, method, headers: { host, ...headers } }, {
    writeHead(status: number, headers: any) { Object.assign(response, { status, headers }); },
    end(body: string) { response.body = JSON.parse(body); }
  }, () => { response.passed = true; });
  return response;
}

test('rehearsal UI rejects forged hosts on all routes and foreign API origins', async t => {
  const boundary = localRehearsalBoundary({ port, directory: await temporary(t) });
  for (const host of ['evil.example', 'localhost:18767', 'localhost', 'localhost:18867.evil.example', '[::1]:18867', undefined]) {
    for (const path of ['/markets', '/api/network', '/api/local-rehearsal/status']) {
      const response = await request(boundary, path, { host: host ?? null });
      assert.equal(response.status, 403); assert.equal(response.passed, false);
    }
  }
  for (const headers of [{ origin: 'https://evil.example' }, { origin: 'null' }, { origin: 'http://127.0.0.1:18867' },
    { origin: 'http://localhost:18867.evil.example' }, { 'sec-fetch-site': 'cross-site' }]) {
    for (const path of ['/api/network', '/api/auth/session', '/api/agent-runtime/profile', '/api/local-rehearsal/status']) {
      const response = await request(boundary, path, headers);
      assert.equal(response.status, 403); assert.equal(response.passed, false);
    }
  }
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`]) {
    const response = await request(boundary, '/api/network', { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' });
    assert.deepEqual(response.body, { ...TESTNET, localRehearsal: true });
    assert.equal(response.headers['Cache-Control'], 'no-store'); assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal((await request(boundary, '/markets', { host })).passed, true);
    assert.equal((await request(boundary, '/api/auth/session', { host })).passed, true);
  }
});

test('rehearsal network and local mint routes cannot fall through to fork defaults', async t => {
  const boundary = localRehearsalBoundary({ port, directory: await temporary(t) });
  for (const [url, method, status] of [['/api/network?fork=true', 'GET', 405], ['/api/network', 'POST', 405],
    ['/api/network', 'HEAD', 405], ['/api/local-wallet-setup', 'POST', 404], ['/api/local-wallet-setup?mint=true', 'GET', 404]]) {
    const response = await request(boundary, url as string, { method });
    assert.equal(response.status, status); assert.equal(response.passed, false);
  }
});

test('rehearsal status is read only and invalid or missing cycle snapshots remain unavailable', async t => {
  const directory = await temporary(t), path = join(directory, 'latest.json'), boundary = localRehearsalBoundary({ port, directory });
  assert.equal((await request(boundary, '/api/local-rehearsal/status')).status, 503);
  for (const body of ['{', JSON.stringify({ schema: 'foreign', secret: 'must-not-return' }),
    JSON.stringify({ schema: 'flurbo.local-rehearsal-cycle.v1', padding: 'x'.repeat(100001) })]) {
    await writeFile(path, body);
    const response = await request(boundary, '/api/local-rehearsal/status');
    assert.equal(response.status, 503); assert.equal(response.body.status, 'not_observed');
    assert.equal(JSON.stringify(response).includes('must-not-return'), false);
  }
  const report = { schema: 'flurbo.local-rehearsal-cycle.v1', checkedAt: 1800000000, worker: { status: 'wait' } };
  await writeFile(path, JSON.stringify(report));
  assert.deepEqual((await request(boundary, '/api/local-rehearsal/status')).body, report);
  assert.equal((await request(boundary, '/api/local-rehearsal/status?path=config.json')).status, 405);
  assert.equal((await request(boundary, '/api/local-rehearsal/status', { method: 'POST' })).status, 405);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), report);
});

test('display index compare and swap permits only one writer for the same revision', async () => {
  const command = rehearsalDisplayCache(), key = 'flurbo:pilot:index:v1:fixture';
  assert.equal(await command('GET', key), null);
  assert.equal(await command('EVAL', cas, 1, key, '', 'initial'), 1);
  const results = await Promise.all(['left', 'right'].map(value => command('EVAL', cas, 1, key, 'initial', value)));
  assert.deepEqual(results, [1, 0]); assert.equal(await command('GET', key), 'left');
  assert.equal(await command('EVAL', cas, 1, key, 'initial', 'stale'), 0);
  assert.equal(await command('GET', key), 'left');
  assert.equal(await rehearsalDisplayCache()('GET', key), null);
});

test('display cache refuses other namespaces, scripts, options and oversized writes without changing entries', async () => {
  const command = rehearsalDisplayCache(), key = 'flurbo:pilot:index:v1:fixture';
  await command('SET', key, 'retained');
  for (const args of [['GET', 'flurbo:session:private'], ['SET', 'flurbo:resolution:journal', 'value'], ['EVAL', 'foreign script', 1, key, 'retained', 'new'],
    ['EVAL', cas, 2, key, 'retained', 'new'], ['EVAL', cas, 1, key, 'retained', 'new', 'extra'], ['SET', key, 'new', 'NX'], ['GET', key, 'extra'],
    ['DEL', key], ['SET', key, { payload: 'object' }], ['SET', key, 'é'.repeat(500001)]]) await assert.rejects(command(...args));
  assert.equal(await command('GET', key), 'retained');
  for (let i = 1; i < 100; i++) await command('SET', `flurbo:pilot:index:v1:${i}`, 'value');
  await assert.rejects(command('SET', 'flurbo:pilot:index:v1:overflow', 'value'), /capacity/);
  assert.equal(await command('SET', key, 'updated'), 'OK'); assert.equal(await command('GET', key), 'updated');
});

function configureFixture() {
  const manifest = deterministicManifest(), base = pilotFixture();
  const calls: string[] = [], persisted: any[] = []; let delivered = false;
  const rpc = async (method: string, params: any[] = []) => {
    calls.push(method);
    if (method === 'eth_call') {
      const abi = params[0].to === manifest.pool ? pilotPoolAbi : resolverAbi;
      // Other addresses use the fixture's cash ABI; only decode our two override targets.
      if ([manifest.pool, manifest.resolver].includes(params[0].to)) {
        const { functionName } = decodeFunctionData({ abi, data: params[0].data });
        if (functionName === 'settlementRulesHash') return encodeFunctionResult({ abi: pilotPoolAbi, functionName, result: manifest.rulesHash });
        if (functionName === 'delivered') return encodeFunctionResult({ abi: resolverAbi, functionName, result: delivered });
      }
    }
    return base.rpc(method, params);
  };
  const reads: string[] = [];
  const deps = { rpc, read: async (path: string) => {
    reads.push(path);
    if (path === resolve(root, 'offline-bootstrap.json')) return JSON.stringify(bootstrap);
    if (path === resolve(root, 'target/deployments/deterministic-test-testnet.json')) return JSON.stringify(manifest);
    throw Error('Unexpected file read');
  }, persist: async (path: string, config: any) => { persisted.push({ path, config }); } };
  return { manifest, base, calls, reads, persisted, deps, deliver: () => { delivered = true; } };
}

test('configuration helper verifies the explicit deterministic deployment using read-only RPC before saving', async () => {
  const f = configureFixture(), report = await configureLocalRehearsal('offline-bootstrap.json', f.deps);
  assert.deepEqual(f.reads, [resolve(root, 'offline-bootstrap.json'), resolve(root, 'target/deployments/deterministic-test-testnet.json')]);
  assert.equal(f.persisted.length, 1);
  assert.equal(f.persisted[0].path, resolve(root, bootstrap.stateDirectory, 'config.json'));
  assert.equal(f.persisted[0].config.pool, f.manifest.pool); assert.equal(f.persisted[0].config.rulesHash, f.manifest.rulesHash);
  assert.equal(report.status, 'configured'); assert.equal(report.signer, signer);
  assert.ok(f.calls.length > 0); assert.ok(f.calls.every(method => ['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call'].includes(method)));
});

test('configuration helper never persists delivered, wrong-chain or invalid-rule collections', async () => {
  for (const state of ['delivered', 'wrong-chain', 'invalid-rules']) {
    const f = configureFixture();
    if (state === 'delivered') f.deliver();
    if (state === 'wrong-chain') f.base.options.chain = 143n;
    if (state === 'invalid-rules') f.manifest.rulesHash = '0x' + 'bb'.repeat(32);
    await assert.rejects(configureLocalRehearsal('offline-bootstrap.json', f.deps));
    assert.equal(f.persisted.length, 0);
  }
});

function configuration() {
  const manifest = deterministicManifest();
  return rehearsalConfig({ ...bootstrap, schema: 'flurbo.local-settlement-rehearsal.v1', manifestPath: 'target/deployments/deterministic-test-testnet.json',
    pool: manifest.pool, rulesHash: manifest.rulesHash });
}

test('configuration persistence accepts reordered equivalent keys without rewriting the original file', async t => {
  const directory = await temporary(t), path = join(directory, 'config.json'), config = configuration();
  const reordered = JSON.stringify(Object.fromEntries(Object.entries(config).reverse()));
  await writeFile(path, reordered);
  await persistLocalRehearsalConfig(path, config);
  assert.equal(await readFile(path, 'utf8'), reordered);
  await assert.rejects(persistLocalRehearsalConfig(path, { ...config, port: port + 1 }), /configuration differs/);
  assert.equal(await readFile(path, 'utf8'), reordered);
  assert.deepEqual(await readdir(directory), ['config.json']);
});

test('concurrent configuration creation cannot replace another rehearsal identity', async t => {
  const directory = await temporary(t), path = join(directory, 'config.json'), config = configuration();
  const candidates = [config, { ...config, signerAddress: '0x' + 'bb'.repeat(20) }];
  const results = await Promise.allSettled(candidates.map(value => persistLocalRehearsalConfig(path, value)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const winner = results.findIndex(result => result.status === 'fulfilled');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), candidates[winner]);
  assert.deepEqual(await readdir(directory), ['config.json']);
  await Promise.all(Array.from({ length: 4 }, () => persistLocalRehearsalConfig(path, candidates[winner])));
});
