import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRealityObservation, hybridSettlementCatalog, hybridSettlementWorker, nextHybridAction,
  nextHybridActions, planRealityAnswer, realityAnswerBytes } from '../server/hybrid-settlement-worker.mjs';
import { pilotEvidence } from '../server/pilot.mjs';
import { digest } from '../server/settlement-rules.mjs';
import { privateKeyToAccount } from 'viem/accounts';

import { at, account, catalog, pool, realityCatalog, resolver } from './hybrid-catalog-fixture.ts';
const state = (phase: number, challengeUntil = 0, arbitrationUntil = 0,
  sourceCaseId = `0x${'0'.repeat(64)}`) =>
  ({ phase, challengeUntil, arbitrationUntil, sourceCaseId });

test('catalog refuses changed rules and missing Kleros adapter', () => {
  const value = catalog();
  assert.equal(hybridSettlementCatalog(value).pools.length, 1);
  const changed = structuredClone(value);
  changed.pools[0].prepared.draft.events[0].rule.decision.value = '5';
  assert.throws(() => hybridSettlementCatalog(changed));
  const noAdapter = structuredClone(value);
  delete noAdapter.pools[0].adapter;
  assert.throws(() => hybridSettlementCatalog(noAdapter));
});

test('mechanical proposal, challenge freeze, deadline and delivery are phase driven', () => {
  const prepared = catalog().pools[0].prepared;
  const snapshot = (now: number, states: any[]) => ({ now, states, prepared,
    delivered: false, resolved: false });
  assert.equal(nextHybridAction(snapshot(at, [state(0), state(0)])), null);
  assert.deepEqual(nextHybridAction(snapshot(at + 3600, [state(0), state(0)])),
    { kind: 'propose', event: 0 });
  assert.deepEqual(nextHybridAction(snapshot(at + 3600, [state(1, at + 7200), state(0)])),
    { kind: 'propose', event: 1 });
  assert.deepEqual(nextHybridAction(snapshot(at + 7200, [state(2, 0, at + 30 * 86400), state(1, at + 7200)])),
    { kind: 'finalize', event: 1 });
  assert.deepEqual(nextHybridAction(snapshot(at + 30 * 86400, [state(2, 0, at + 30 * 86400), state(3)])),
    { kind: 'finalize', event: 0 });
  assert.equal(nextHybridAction(snapshot(at + 30 * 86400,
    [state(2, 0, at + 30 * 86400, `0x${'1'.repeat(64)}`), state(3)])), null);
  assert.deepEqual(nextHybridAction(snapshot(at + 30 * 86400, [state(3), state(3)])),
    { kind: 'deliver' });
  assert.deepEqual(nextHybridAction(snapshot(at + 7200, [state(0), state(0)])),
    { kind: 'finalize', event: 0 });
});

test('catalog requires keeper and answerer for rule-backed Reality events', () => {
  const value = realityCatalog();
  assert.equal(hybridSettlementCatalog(value).pools.length, 1);
  const noKeeper = structuredClone(value);
  delete noKeeper.pools[0].keeper;
  assert.throws(() => hybridSettlementCatalog(noKeeper), /Invalid hybrid pool/);
  const noAnswerer = structuredClone(value);
  delete noAnswerer.pools[0].answerer;
  assert.throws(() => hybridSettlementCatalog(noAnswerer), /Invalid hybrid pool/);
  assert.equal(hybridSettlementCatalog(catalog(['mechanical', 'reality'])).pools.length, 1);
});

const reality = (phase: number) => state(phase);
const realitySnapshot = (now: number, states: any[], routes = ['reality', 'mechanical']) =>
  ({ now, states, prepared: catalog(routes).pools[0].prepared, delivered: false, resolved: false });

test('next actions are independent per event', () => {
  const snapshot = realitySnapshot(at + 3600, [reality(0), reality(0)]);
  assert.deepEqual(nextHybridActions(snapshot),
    [{ kind: 'reality', event: 0 }, { kind: 'propose', event: 1 }]);
  assert.deepEqual(nextHybridAction(snapshot), { kind: 'reality', event: 0 });
});

test('deliver and finalize keep precedence', () => {
  assert.deepEqual(nextHybridActions(realitySnapshot(at + 3600, [reality(3), reality(3)])), [{ kind: 'deliver' }]);
  const late = realitySnapshot(at + 3600 + 3600, [reality(0), reality(0)]);
  assert.deepEqual(nextHybridActions(late), [{ kind: 'finalize', event: 1 }, { kind: 'reality', event: 0 }]);
});

test('answer plan', () => {
  const ready = { now: 200, opensAt: 100, bondWei: '0', finalized: false, pendingArbitration: false,
    observation: { outcome: 2 } };
  assert.equal(planRealityAnswer({ ...ready, now: 99 }), 'waiting_open');
  assert.equal(planRealityAnswer({ ...ready, bondWei: '1' }), 'already_answered');
  assert.equal(planRealityAnswer({ ...ready, finalized: true }), 'already_answered');
  assert.equal(planRealityAnswer({ ...ready, pendingArbitration: true }), 'already_answered');
  assert.equal(planRealityAnswer({ ...ready, observation: null }), 'waiting_source');
  assert.equal(planRealityAnswer(ready), 'answer');
});

test('reader outcomes map to Reality answers', () => {
  assert.equal(realityAnswerBytes[1], `0x${'0'.repeat(64)}`);
  assert.equal(realityAnswerBytes[2], `0x${'0'.repeat(63)}1`);
  assert.equal(realityAnswerBytes[3], `0x${'f'.repeat(64)}`);
});

const origin = 'https://flurbopm.singu.online';
const questionOf = (index: number) => `0x${['a', 'b'][index].repeat(64)}`;
function memory() {
  const values = new Map<string, string>();
  return { values, command: async (op: string, name: string, value?: string, ...options: string[]) => {
    if (op === 'GET') return values.get(name) ?? null;
    if (op === 'SET') {
      if (options.includes('NX') && values.has(name)) return null;
      values.set(name, value || ''); return 'OK';
    }
    if (op === 'DEL') return values.delete(name) ? 1 : 0;
    if (op === 'EVAL') return 1;
    throw Error(`Unexpected Redis operation ${op}`);
  } };
}
const jsonCapture = (rule: any, body = '{"value":4.25}', fetchedAt = at + 30) => ({
  requestedUrl: rule.source.urls[0], finalUrl: rule.source.urls[0], fetchedAt, status: 200,
  contentType: 'application/json', complete: true, body, bytes: Buffer.byteLength(body), sha256: digest(body) });
function publicRequest(store: any) {
  return async (url: string) => {
    const hash = url.slice(url.lastIndexOf('/') + 1);
    const body = Buffer.from(await store.get(hash));
    return { status: 200, redirected: false, url, body: (async function* () { yield body; })(),
      headers: { has: () => false, get: (name: string) => name === 'content-type' ? 'application/json' : null } };
  };
}

test('missing capture after the cutoff freezes a Void observation', async () => {
  const rule = (realityCatalog().pools[0].prepared.draft.events[0] as any).rule;
  const archive = pilotEvidence(memory().command, origin);
  const input = { rule, questionId: questionOf(0), captures: [], attempt: null, archive,
    packetStore: null, owner: account('9'), draftHash: `0x${'1'.repeat(64)}`, origin, request: fetch };
  assert.equal(await buildRealityObservation({ ...input, now: rule.timing.publicationCutoff }), null);
  const observation = await buildRealityObservation({ ...input, now: rule.timing.publicationCutoff + 1 });
  assert.equal(observation?.outcome, 3);
  assert.equal(observation?.answer, realityAnswerBytes[3]);
  assert.match(observation?.evidenceURI || '', /\/api\/pilot\/evidence\/0x[0-9a-f]{64}$/);
});

const keys = { proposer: `0x${'11'.repeat(32)}`, relay: `0x${'22'.repeat(32)}`, answerer: `0x${'33'.repeat(32)}` };
const actor = (name: keyof typeof keys) => privateKeyToAccount(keys[name] as `0x${string}`).address;

function workerFixture({ failChain = false } = {}) {
  const pools = catalog(['reality', 'reality'], { proposer: actor('proposer'), relay: actor('relay'),
    answerer: actor('answerer') }).pools;
  const events: any[] = pools[0].prepared.draft.events;
  const redis = memory();
  const archive = pilotEvidence(redis.command, origin);
  const writes: any[] = [];
  const market = {
    getChainId: async () => 10143,
    getBlock: async () => ({ hash: `0x${'9'.repeat(64)}`, number: 200n, timestamp: BigInt(at + 3700) }),
    readContract: async ({ address, functionName, args = [] }: any) => {
      const isPool = address.toLowerCase() === pool.toLowerCase();
      const prepared = pools[0].prepared;
      const values: Record<string, unknown> = {
        protocolVersion: isPool ? 3n : 4n, rulesHash: pools[0].rulesHash, draftHash: prepared.draftHash,
        pool, proposer: prepared.proposer, relay: prepared.relay, bond: 1000000n, eventCount: 2n,
        resolver, settlementRulesHash: pools[0].rulesHash, funded: true, resolved: false, delivered: false,
        collateral: '0xa9012a055bd4e0edff8ce09f960291c09d5322dc', routes: 1n,
        eventHashes: prepared.eventHashes[Number(args[0])], observationEnds: BigInt(at + 3600),
        caseState: { phase: 0n, challengeUntil: 0n, arbitrationUntil: 0n, sourceCaseId: `0x${'0'.repeat(64)}` } };
      return values[functionName];
    },
  };
  const bond = 100000000000000n;
  const source = {
    getChainId: async () => { if (failChain) throw Error('request to https://secret.example/abc failed'); return 11155111; },
    getBlock: async () => ({ timestamp: BigInt(at + 3700), number: 50n, hash: `0x${'8'.repeat(64)}` }),
    getBalance: async () => 10n ** 18n,
    getTransactionReceipt: async () => { const error = Error('pending'); error.name = 'TransactionReceiptNotFoundError'; throw error; },
    simulateContract: async (request: any) => ({ request }),
    readContract: async ({ functionName, args = [] }: any) => {
      const index = args[0] === questionOf(1) ? 1 : 0, item = events[index].source;
      const values: Record<string, unknown> = {
        getContentHash: item.contentHash, getArbitrator: item.arbitrator, getOpeningTS: BigInt(at + 3600),
        getTimeout: 3600n, getMinBond: bond, getBond: 0n, getFinalizeTS: 0n,
        getBestAnswer: `0x${'0'.repeat(64)}`, getHistoryHash: `0x${'0'.repeat(64)}`,
        isPendingArbitration: false, isFinalized: false, getDisputeFee: 10n ** 16n,
        realitio: item.reality, arbitrationRequests: [0n, account('1'), 0n, 0n], balanceOf: 0n };
      return values[functionName];
    },
  };
  const capture = jsonCapture(events[0].rule);
  const captureStore = { list: async () => [capture], put: async () => ({}), recordAttempt: async () => true,
    latestAttempt: async () => null };
  const packetStore = { put: async () => { throw Error('unused'); }, get: async () => { throw Error('unused'); } };
  const answererWallet = { writeContract: async (request: any) => {
    writes.push(request); return `0x${String(writes.length).repeat(64)}`; } };
  const build = () => hybridSettlementWorker({ pools, market, source, command: redis.command, archive,
    captureStore, packetStore, oracleEvidence: { putRelay: async () => '' }, origin,
    marketRpcUrl: 'https://market.example', sourceRpcUrl: 'https://source.example',
    proposerPrivateKey: keys.proposer, relayPrivateKey: keys.relay, answererPrivateKey: keys.answerer,
    answererWallet, proposerWallet: {}, relayWallet: {}, request: publicRequest(archive),
    now: () => at + 3700 });
  return { build, writes, redis, bond };
}

test('answer is submitted once across restarts', async () => {
  const { build, writes, bond } = workerFixture();
  await build().tick();
  await build().tick();
  for (const index of [0, 1]) {
    const calls = writes.filter(call => call.args[0] === questionOf(index));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].functionName, 'submitAnswer');
    assert.equal(calls[0].value, bond);
    assert.equal(calls[0].args[1], realityAnswerBytes[2]);
    assert.equal(calls[0].args[2], 0n);
  }
  const worker = build();
  await worker.tick();
  assert.equal(writes.length, 2);
  assert.equal(worker.status().lastError, null);
});

test('worker errors are masked', async () => {
  const { build } = workerFixture({ failChain: true });
  const worker = build();
  await worker.tick();
  assert.equal(worker.status().lastError, 'Hybrid settlement source or transaction request failed');
});
