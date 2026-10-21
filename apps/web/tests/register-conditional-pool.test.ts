import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getAddress, keccak256 } from 'viem';
import { hybridRulesHash, prepareHybridPilot } from '../scripts/prepare-hybrid-pilot.mjs';
import { candidatePath, verifyConditionalDeployment } from '../scripts/register-conditional-pool.mjs';
import { verifyLsPricer } from '../scripts/register-ls-pricer.mjs';
import { TEST_AUSD } from '../server/oracle-integration.mjs';
import { runtimeCodeHash } from '../shared/conditionals.mjs';
import { depthRateWad } from '../shared/ls-lmsr.mjs';
import { completedDraft, fakeSepolia, proxyCode } from './hybrid-reality-fixture.ts';

const account = (digit: string) => `0x${digit.repeat(40)}`;
const pool = account('5'), resolver = account('4'), pricer = '0x' + 'cc'.repeat(20);
const pricerCode = '0x600160026003' + 'a1' + '0001';
const emptyCatalog = { schema: 'flurbo.conditional-catalog.v1', pricer: null, pools: [] };
const pricedCatalog = { ...emptyCatalog, pricer };
const hybridCatalog = JSON.parse(await readFile(new URL('../../../config/hybrid-markets.json', import.meta.url), 'utf8'));

async function fixture() {
  const { template, draft } = await completedDraft();
  const prepared = prepareHybridPilot({ ...draft, schema: 'flurbo.hybrid-publication.v5', commissionBps: 500 });
  const rulesHash = hybridRulesHash(prepared, resolver);
  const unverified = { schema: 'flurbo.hybrid-manifest.v5', status: 'unverified_deployment', pool, resolver,
    creator: prepared.creator, proposer: prepared.proposer, relay: prepared.relay, draftHash: prepared.draftHash,
    configHash: prepared.configHash, rulesHash, commissionBps: prepared.commissionBps,
    initialDepthAtoms: Number(prepared.liquidityAtoms), depthRate: Number(depthRateWad(prepared.draft.events.length, 500)),
    pricer, conditionalVersion: 1 };
  return { prepared, rulesHash, unverified, source: fakeSepolia(template) };
}

function market(prepared: any, rulesHash: string, override: Record<string, unknown> = {}) {
  return {
    getChainId: async () => 10143,
    getBlock: async () => ({ hash: `0x${'9'.repeat(64)}`, number: 200n, timestamp: 1000n }),
    getBytecode: async () => override.code ?? pricerCode,
    readContract: async ({ address, functionName, args = [] }: any) => {
      const isPool = address.toLowerCase() === pool.toLowerCase();
      const values: Record<string, unknown> = {
        protocolVersion: isPool ? 5 : 4, rulesHash, draftHash: prepared.draftHash, pool,
        liquidity: BigInt(prepared.liquidityAtoms), commissionBps: prepared.commissionBps, sponsor: prepared.creator,
        proposer: prepared.proposer, relay: prepared.relay, bond: 1000000n, eventCount: 2n,
        resolver, settlementRulesHash: rulesHash, collateral: TEST_AUSD, funded: true,
        resolved: false, delivered: false, routes: 1n, eventHashes: prepared.eventHashes[Number(args[0])],
        observationEnds: BigInt(prepared.draft.events[Number(args[0])]?.observationEndsAt ?? 0),
        conditionalVersion: 'conditionalVersion' in override ? override.conditionalVersion : 1,
        pricer: override.pricer ?? pricer, version: override.version ?? 1 };
      return values[functionName];
    },
  };
}

const roles = { id: 'cond-1', keeper: account('8'), answerer: account('9'), proxyCodeHash: keccak256(proxyCode) };

test('a valid deployment is written to the conditional registry only', async () => {
  const { prepared, rulesHash, unverified, source } = await fixture();
  const before = JSON.stringify(hybridCatalog);
  const candidate = await verifyConditionalDeployment({ ...roles, prepared, unverified, catalog: pricedCatalog, hybridCatalog,
    market: market(prepared, rulesHash), source });
  assert.equal(candidate.schema, 'flurbo.conditional-catalog.v1');
  assert.equal(candidate.pricer, pricer);
  assert.equal(candidate.pools.length, 1);
  assert.equal(candidate.pools[0].conditionalVersion, 1);
  assert.equal(candidate.pools[0].pool, pool);
  assert.equal(candidate.pools[0].keeper, account('8'));
  assert.equal(JSON.stringify(hybridCatalog), before);
});

test('a wrong pricer or a pool without conditionalVersion is refused', async () => {
  const { prepared, rulesHash, unverified, source } = await fixture();
  const verify = (changes: { manifest?: Record<string, unknown>; chain?: Record<string, unknown>; catalog?: any }) =>
    verifyConditionalDeployment({ ...roles, prepared, unverified: { ...unverified, ...changes.manifest },
      catalog: changes.catalog ?? pricedCatalog, hybridCatalog, market: market(prepared, rulesHash, changes.chain), source });
  await assert.rejects(verify({ manifest: { pricer: account('d') } }), /another pricer/);
  await assert.rejects(verify({ manifest: { conditionalVersion: undefined } }), /another pricer/);
  await assert.rejects(verify({ catalog: emptyCatalog }), /Register the pricer first/);
  await assert.rejects(verify({ chain: { conditionalVersion: undefined } }), /not a conditional pool/);
  await assert.rejects(verify({ chain: { conditionalVersion: 2 } }), /not a conditional pool/);
  await assert.rejects(verify({ chain: { pricer: account('d') } }), /not a conditional pool/);
  const taken = { ...hybridCatalog, pools: [...hybridCatalog.pools] };
  taken.pools[0] = { ...taken.pools[0], pool };
  await assert.rejects(verifyConditionalDeployment({ ...roles, prepared, unverified, catalog: pricedCatalog, hybridCatalog: taken,
    market: market(prepared, rulesHash), source }), /Invalid hybrid pool/);
});

test('candidates are never written under config', () => {
  for (const [path, cwd] of [['config/hybrid-markets.json', '/repo'], ['config/conditional-markets.json', '/repo'],
    ['../../config/x.json', '/repo/apps/web'], ['./config/new.json', '/repo'], ['/repo/config', '/elsewhere']])
    assert.throws(() => candidatePath(path, cwd, '/repo'), /Write the candidate outside config/, path);
  assert.ok(candidatePath('../Flurbo-contracts/target/deployments/conditional-catalog-candidate.json', '/repo', '/repo'));
  assert.ok(candidatePath('configs/x.json', '/repo', '/repo'));
});

test('register-ls-pricer refuses a wrong code hash and refuses to replace a pricer', async () => {
  const deployment = { schema: 'flurbo.ls-pricer.v1', pricer, version: 1 };
  const { prepared, rulesHash } = await fixture();
  const codeHash = runtimeCodeHash(pricerCode)!;
  const candidate = await verifyLsPricer({ deployment, catalog: emptyCatalog, market: market(prepared, rulesHash), codeHash });
  assert.deepEqual(candidate, { ...emptyCatalog, pricer: getAddress(pricer) });
  await assert.rejects(verifyLsPricer({ deployment, catalog: emptyCatalog, market: market(prepared, rulesHash, { code: '0x6001' }), codeHash }),
    /Pricer code differs from LsPricer/);
  await assert.rejects(verifyLsPricer({ deployment, catalog: emptyCatalog, market: market(prepared, rulesHash, { version: 2 }), codeHash }),
    /Pricer version mismatch/);
  await assert.rejects(verifyLsPricer({ deployment, catalog: pricedCatalog, market: market(prepared, rulesHash), codeHash }),
    /already has a pricer/);
  for (const bad of [{ ...deployment, schema: 'x' }, { ...deployment, pricer: 'nope' }, { ...deployment, version: 2 }])
    await assert.rejects(verifyLsPricer({ deployment: bad, catalog: emptyCatalog, market: market(prepared, rulesHash), codeHash }),
      /Pricer deployment file is invalid/);
  await assert.rejects(verifyLsPricer({ deployment, catalog: emptyCatalog, market: { ...market(prepared, rulesHash), getChainId: async () => 1 }, codeHash }),
    /Monad RPC chain mismatch/);
});
