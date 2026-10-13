import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, keccak256, parseAbiParameters } from 'viem';
import { hybridRulesHash, isLsPrepared } from '../scripts/prepare-hybrid-pilot.mjs';
import { depthRateWad } from '../shared/ls-lmsr.mjs';
import { prepareHybridPilot } from '../scripts/prepare-hybrid-pilot.mjs';
import { verifyHybridDeployment } from '../scripts/register-hybrid-pool.mjs';
import { TEST_AUSD } from '../server/oracle-integration.mjs';
import { createHybridEvmPilot } from '../scripts/create-hybrid-evm-pilot.mjs';
import { completedDraft, creator, fakeSepolia, proposer, proxyCode, relay } from './hybrid-reality-fixture.ts';

const account = (digit: string) => `0x${digit.repeat(40)}`;
const pool = account('5'), resolver = account('4');

// Deployment output for a prepared publication: v5 adds the commission, initial depth and rate.
function manifestFor(prepared: any, rulesHash: string): Record<string, unknown> {
  const base = { status: 'unverified_deployment', pool, resolver, creator: prepared.creator, proposer: prepared.proposer,
    relay: prepared.relay, draftHash: prepared.draftHash, configHash: prepared.configHash, rulesHash };
  if (!isLsPrepared(prepared)) return { schema: 'flurbo.hybrid-manifest.v4', ...base };
  return { schema: 'flurbo.hybrid-manifest.v5', ...base, commissionBps: prepared.commissionBps,
    initialDepthAtoms: Number(prepared.liquidityAtoms),
    depthRate: Number(depthRateWad(prepared.draft.events.length, prepared.commissionBps)) };
}

async function fixture(override: Record<string, unknown> = {}) {
  const { template, draft } = await completedDraft();
  const prepared = prepareHybridPilot(draft);
  const rulesHash = hybridRulesHash(prepared, resolver);
  const unverified = manifestFor(prepared, rulesHash);
  return { template, prepared, unverified, rulesHash, source: fakeSepolia(template, override) };
}

const unreachable = new Proxy({}, { get: () => () => { throw Error('chain read'); } });

function market(prepared: any, rulesHash: string, pool_: Record<string, unknown> = {}) {
  return {
    getChainId: async () => 10143,
    getBlock: async () => ({ hash: `0x${'9'.repeat(64)}`, number: 200n, timestamp: 1000n }),
    readContract: async ({ address, functionName, args = [] }: any) => {
      const isPool = address.toLowerCase() === pool.toLowerCase();
      const values: Record<string, unknown> = {
        protocolVersion: isPool ? (isLsPrepared(prepared) ? 5 : 3) : 4, rulesHash, draftHash: prepared.draftHash, pool,
        liquidity: BigInt(prepared.liquidityAtoms), commissionBps: prepared.commissionBps, sponsor: prepared.creator,
        proposer: prepared.proposer, relay: prepared.relay, bond: 1000000n, eventCount: 2n,
        resolver, settlementRulesHash: rulesHash, collateral: TEST_AUSD, funded: true,
        resolved: false, delivered: false, routes: 1n,
        eventHashes: prepared.eventHashes[Number(args[0])],
        observationEnds: BigInt(prepared.draft.events[Number(args[0])]?.observationEndsAt ?? 0),
        caseState: { phase: 0n, challengeUntil: 0n, arbitrationUntil: 0n,
          sourceCaseId: `0x${'0'.repeat(64)}` }, ...(isPool ? pool_ : {}) };
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
    keeper: account('8'), answerer: account('9'), market: market(prepared, rulesHash), source,
    proxyCodeHash: keccak256(proxyCode) });
  assert.equal(record.keeper, account('8'));
  assert.equal(record.answerer, account('9'));
  assert.equal('adapter' in record, false);
  assert.equal(record.deploymentBlock, 200);
});

test('registration rejects a proxy that is not the verified Kleros code', async () => {
  const { prepared, unverified, rulesHash, source } = await fixture({ proxyCode: '0x6081' });
  await assert.rejects(() => verifyHybridDeployment({ id: 'reality-test', prepared, unverified,
    keeper: account('8'), answerer: account('9'), market: market(prepared, rulesHash), source,
    proxyCodeHash: keccak256(proxyCode) }), /Reality arbitrator is not a verified Kleros proxy/);
});

test('registration rejects a proxy with more than one juror seat', async () => {
  const { prepared, unverified, rulesHash, source } = await fixture({
    extraData: encodeAbiParameters(parseAbiParameters('uint256,uint256'), [3n, 2n]) });
  await assert.rejects(() => verifyHybridDeployment({ id: 'reality-test', prepared, unverified,
    keeper: account('8'), answerer: account('9'), market: market(prepared, rulesHash), source,
    proxyCodeHash: keccak256(proxyCode) }), /Reality arbitrator is not a verified Kleros proxy/);
});

test('mechanical-only registration is unchanged', async () => {
  const prepared = prepareHybridPilot(createHybridEvmPilot({ creator, proposer, relay,
    closesAt: Math.floor(Date.now() / 1000) + 3 * 3600 }));
  const unverified = manifestFor(prepared, hybridRulesHash(prepared, resolver));
  const base = { id: 'mechanical-test', prepared, unverified, market: unreachable };
  await assert.rejects(() => verifyHybridDeployment({ ...base, source: unreachable }),
    /Hybrid deployment roles incomplete/);
  await assert.rejects(() => verifyHybridDeployment({ ...base, adapter: account('6'),
    manager: account('7'), source: { getChainId: async () => 1 } }), /Sepolia RPC chain mismatch/);
});

async function lsFixture() {
  const { template, draft } = await completedDraft();
  const prepared = prepareHybridPilot({ ...draft, schema: 'flurbo.hybrid-publication.v5', commissionBps: 500 });
  const rulesHash = hybridRulesHash(prepared, resolver);
  return { prepared, rulesHash, unverified: manifestFor(prepared, rulesHash), source: fakeSepolia(template),
    roles: { id: 'ls-test', keeper: account('8'), answerer: account('9'), proxyCodeHash: keccak256(proxyCode) } };
}

test('v5 registration requires a v5 manifest with the prepared commission and depth', async () => {
  const { prepared, rulesHash, unverified, source, roles } = await lsFixture();
  assert.equal(prepared.schema, 'flurbo.hybrid-prepared.v5');
  const verify = (manifest: Record<string, unknown>) => verifyHybridDeployment({ ...roles, prepared,
    unverified: manifest, market: market(prepared, rulesHash), source });
  for (const change of [{ schema: 'flurbo.hybrid-manifest.v4' }, { commissionBps: 1000 }, { commissionBps: undefined },
    { initialDepthAtoms: 20000000 }, { initialDepthAtoms: undefined }])
    await assert.rejects(() => verify({ ...unverified, ...change }), /differs from the prepared publication/);
  const record = await verify(unverified);
  assert.equal(record.prepared.commissionBps, 500);
  assert.equal(record.deploymentBlock, 200);
});

test('v5 registration rejects a pool whose on-chain commission differs', async () => {
  const { prepared, rulesHash, unverified, source, roles } = await lsFixture();
  for (const change of [{ commissionBps: 1000 }, { liquidity: 20000000n }, { protocolVersion: 3 }])
    await assert.rejects(() => verifyHybridDeployment({ ...roles, prepared, unverified,
      market: market(prepared, rulesHash, change), source }), /Hybrid pool differs from verified catalog/);
});

test('v5 registration rejects a pool whose sponsor is not the creator', async () => {
  const { prepared, rulesHash, unverified, source, roles } = await lsFixture();
  await assert.rejects(() => verifyHybridDeployment({ ...roles, prepared, unverified,
    market: market(prepared, rulesHash, { sponsor: account('2') }), source }), /Hybrid pool differs from verified catalog/);
});
