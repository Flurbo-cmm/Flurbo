import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hybridArbitrationCatalog, hybridDisputeSnapshot } from '../server/hybrid-arbitration-worker.mjs';

const address = (byte: string) => `0x${byte.repeat(40)}`;
const hash = (byte: string) => `0x${byte.repeat(64)}`;
const route = { id: 'test-question', pool: address('1'), resolver: address('2'), adapter: address('3'),
  manager: address('4'), relay: address('5'), rulesHash: hash('a'), eventHash: hash('b'),
  eventIndex: 0, deploymentBlock: 100, question: 'Did the official source report the exact result?' };
const state = { phase: 2, proposal: 2, counter: 1, result: 0, challenger: address('6'),
  evidenceHash: hash('c'), counterEvidenceHash: hash('d'), requestId: hash('e'),
  sourceCaseId: hash('0'), challengeUntil: 1000n, arbitrationUntil: 99999999n };

function clients(caseState: any, monadState = state) {
  const market = { getChainId: async () => 10143, readContract: async ({ functionName }: any) => ({
    protocolVersion: 4, rulesHash: route.rulesHash, pool: route.pool, relay: route.relay,
    eventHashes: route.eventHash, routes: 0, caseState: monadState,
  } as any)[functionName] };
  const source = { getChainId: async () => 11155111,
    getBlock: async () => ({ number: 500n, hash: hash('f') }),
    readContract: async ({ functionName }: any) => ({ manager: route.manager,
      caseState, sourceCaseId: hash('9') } as any)[functionName] };
  return [market, source] as const;
}

test('catalog rejects duplicate events and missing route bindings', () => {
  assert.equal(hybridArbitrationCatalog({ schema: 'flurbo.hybrid-arbitration-catalog.v1', routes: [route] }).routes.length, 1);
  assert.throws(() => hybridArbitrationCatalog({ schema: 'flurbo.hybrid-arbitration-catalog.v1', routes: [route, { ...route, id: 'other' }] }));
  assert.throws(() => hybridArbitrationCatalog({ schema: 'flurbo.hybrid-arbitration-catalog.v1', routes: [{ ...route, eventHash: 'bad' }] }));
});

test('source case must match the exact Monad request and question', async () => {
  const unopened = { disputeId: 0n, requestId: hash('0'), questionHash: hash('0'), ruling: 0, opened: false, ruled: false };
  assert.equal((await hybridDisputeSnapshot(route, ...clients(unopened))).action, 'open');
  const opened = { disputeId: 7n, requestId: state.requestId, questionHash: route.eventHash,
    ruling: 0, opened: true, ruled: false };
  assert.equal((await hybridDisputeSnapshot(route, ...clients(opened))).action, 'link');
  await assert.rejects(() => hybridDisputeSnapshot(route, ...clients({ ...opened, questionHash: hash('8') })),
    /differs from Monad question/);
  const linked = { ...state, sourceCaseId: hash('9') };
  assert.equal((await hybridDisputeSnapshot(route, ...clients(opened, linked))).action, 'wait');
  assert.equal((await hybridDisputeSnapshot(route, ...clients({ ...opened, ruled: true, ruling: 2 }, linked))).action, 'report');
  await assert.rejects(() => hybridDisputeSnapshot(route, ...clients({ ...opened, ruled: true, ruling: 4 }, linked)),
    /Invalid Kleros ruling/);
});

test('a wrong resolver or linked case cannot be reported', async () => {
  const opened = { disputeId: 7n, requestId: state.requestId, questionHash: route.eventHash,
    ruling: 2, opened: true, ruled: true };
  const [market, source] = clients(opened, { ...state, sourceCaseId: hash('8') });
  await assert.rejects(() => hybridDisputeSnapshot(route, market, source), /Linked source case differs/);
  const wrong = { ...market, readContract: async ({ functionName }: any) => functionName === 'eventHashes' ? hash('8')
    : market.readContract({ functionName }) };
  await assert.rejects(() => hybridDisputeSnapshot(route, wrong, source), /differs from deployed contracts/);
});
