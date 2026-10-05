import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hybridRulesHash } from '../scripts/prepare-hybrid-pilot.mjs';
import { prepareHybridPilot } from '../scripts/prepare-hybrid-pilot.mjs';
import { verifyHybridDeployment } from '../scripts/register-hybrid-pool.mjs';
import { TEST_AUSD } from '../server/oracle-integration.mjs';
import { createHybridEvmPilot } from '../scripts/create-hybrid-evm-pilot.mjs';
import { completedDraft, creator, fakeSepolia, proposer, relay } from './hybrid-reality-fixture.ts';

const account = (digit: string) => `0x${digit.repeat(40)}`;
const pool = account('5'), resolver = account('4');

async function fixture(override: Record<string, unknown> = {}) {
  const { template, draft } = await completedDraft();
  const prepared = prepareHybridPilot(draft);
  const rulesHash = hybridRulesHash(prepared, resolver);
  const unverified = { schema: 'flurbo.hybrid-manifest.v4', status: 'unverified_deployment',
    pool, resolver, creator: prepared.creator, proposer: prepared.proposer, relay: prepared.relay,
    draftHash: prepared.draftHash, configHash: prepared.configHash, rulesHash };
  return { template, prepared, unverified, rulesHash, source: fakeSepolia(template, override) };
}

const unreachable = new Proxy({}, { get: () => () => { throw Error('chain read'); } });

function market(prepared: any, rulesHash: string) {
  return {
    getChainId: async () => 10143,
    getBlock: async () => ({ hash: `0x${'9'.repeat(64)}`, number: 200n, timestamp: 1000n }),
    readContract: async ({ address, functionName, args = [] }: any) => {
      const isPool = address.toLowerCase() === pool.toLowerCase();
      const values: Record<string, unknown> = {
        protocolVersion: isPool ? 3n : 4n, rulesHash, draftHash: prepared.draftHash, pool,
        proposer: prepared.proposer, relay: prepared.relay, bond: 1000000n, eventCount: 2n,
        resolver, settlementRulesHash: rulesHash, collateral: TEST_AUSD, funded: true,
        resolved: false, delivered: false, routes: 1n,
        eventHashes: prepared.eventHashes[Number(args[0])],
        observationEnds: BigInt(prepared.draft.events[Number(args[0])]?.observationEndsAt ?? 0),
        caseState: { phase: 0n, challengeUntil: 0n, arbitrationUntil: 0n,
          sourceCaseId: `0x${'0'.repeat(64)}` } };
      return values[functionName];
    },
  };
}

test('registration requires keeper and answerer for a rule-backed Reality pool', async () => {
  const { prepared, unverified } = await fixture();
  const base = { id: 'reality-test', prepared, unverified, market: unreachable, source: unreachable };
  await assert.rejects(() => verifyHybridDeployment(base), /Hybrid deployment roles incomplete/);
  await assert.rejects(() => verifyHybridDeployment({ ...base, keeper: account('8') }),
    /Hybrid deployment roles incomplete/);
  await assert.rejects(() => verifyHybridDeployment({ ...base, keeper: account('8'),
    answerer: prepared.relay }), /Hybrid deployment roles incomplete/);
});

test('registration rejects a Reality question receipt that differs from the publication', async () => {
  const { prepared, unverified, rulesHash, source } = await fixture({ questionText: 'different␟flurbo␟en' });
  await assert.rejects(() => verifyHybridDeployment({ id: 'reality-test', prepared, unverified,
    keeper: account('8'), answerer: account('9'), market: market(prepared, rulesHash), source }),
  /Pinned Reality question, title, creator or opening time mismatch/);
});

test('registration records keeper and answerer for a verified Reality pool', async () => {
  const { prepared, unverified, rulesHash, source } = await fixture();
  const record = await verifyHybridDeployment({ id: 'reality-test', prepared, unverified,
    keeper: account('8'), answerer: account('9'), market: market(prepared, rulesHash), source });
  assert.equal(record.keeper, account('8'));
  assert.equal(record.answerer, account('9'));
  assert.equal('adapter' in record, false);
  assert.equal(record.deploymentBlock, 200);
});

test('mechanical-only registration is unchanged', async () => {
  const prepared = prepareHybridPilot(createHybridEvmPilot({ creator, proposer, relay,
    closesAt: Math.floor(Date.now() / 1000) + 3 * 3600 }));
  const unverified = { schema: 'flurbo.hybrid-manifest.v4', status: 'unverified_deployment',
    pool, resolver, creator: prepared.creator, proposer: prepared.proposer, relay: prepared.relay,
    draftHash: prepared.draftHash, configHash: prepared.configHash,
    rulesHash: hybridRulesHash(prepared, resolver) };
  const base = { id: 'mechanical-test', prepared, unverified, market: unreachable };
  await assert.rejects(() => verifyHybridDeployment({ ...base, source: unreachable }),
    /Hybrid deployment roles incomplete/);
  await assert.rejects(() => verifyHybridDeployment({ ...base, adapter: account('6'),
    manager: account('7'), source: { getChainId: async () => 1 } }), /Sepolia RPC chain mismatch/);
});
