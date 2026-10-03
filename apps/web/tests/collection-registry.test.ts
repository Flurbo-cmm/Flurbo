import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateRegistry, loadRegistry, listedCollections, monitoredCollections, heldPools, registryEnabled, MAX_LISTED_COLLECTIONS } from '../server/collection-registry.mjs';
import { configurePracticeCollections, practiceNamespace } from '../server/practice-collections.mjs';
import { registryPlan, idlePools, runResolution } from '../scripts/run-resolution.mjs';
import { skipCheck, POOL_RECHECK_SECONDS } from '../scripts/notify-settlement.mjs';
import { settlementBindings, pilotRulesHash } from '../server/settlement-publication.mjs';
import { deterministicManifest } from './deterministic-fixture.ts';
import { pilotFixture } from './pilot-fixture.ts';

const rehearsal = JSON.parse(await readFile(new URL('./fixtures/rehearsal-manifest.json', import.meta.url), 'utf8'));
const hex = (n: number, bytes: number) => '0x' + n.toString(16).padStart(2, '0').repeat(bytes);
// A deterministic manifest at its own pool and resolver, with its rules hash rebound to that resolver.
function deterministicAt(n: number, bond = '1000000') {
  const m: any = deterministicManifest(), code = m.codeHashes[m.pool];
  m.pool = hex(n, 20); m.resolver = hex(n + 1, 20); m.codeHashes = { [m.pool]: code, [m.resolver]: code };
  m.publication.bondAtoms = bond;
  const bindings = settlementBindings(m.publication);
  m.draftHash = bindings.draftHash; m.configHash = bindings.configHash;
  m.rulesHash = pilotRulesHash(bindings.config, m.resolver, m.publication.creator);
  return m;
}
const registryOf = (collections: any[], featured: string | null = collections.find(c => c.status === 'active')?.manifest.pool ?? null) =>
  ({ schema: 'flurbo.collections.v1', featured, pilotSettlement: 'finish-only', collections });
const row = (manifest: any, label: string, settlement = 'auto', status = 'active') => ({ label, settlement, status, manifest });

test('registry accepts listed, finish-only, off and retired pools, and rejects unsafe or ambiguous entries', () => {
  const a = deterministicAt(0x11), b = deterministicAt(0x21), c = deterministicAt(0x31);
  const registry = registryOf([row(a, 'Jobs Friday'), row(b, 'Crypto weekend', 'finish-only'), row(c, 'Old pool', 'off', 'retired'), row(rehearsal, 'Practice run', 'off')]);
  assert.equal(validateRegistry(registry), registry);
  assert.deepEqual(listedCollections(registry).map((r: any) => r.label), ['Jobs Friday', 'Crypto weekend', 'Practice run']);
  // The monitor watches everything listed, plus retired pools the bot may still act on.
  const retiredButSettling = registryOf([row(a, 'Jobs Friday'), row(c, 'Old pool', 'finish-only', 'retired')]);
  assert.deepEqual(monitoredCollections(retiredButSettling).map((r: any) => r.label), ['Jobs Friday', 'Old pool']);
  const bad = (change: (r: any) => void, message: RegExp) => { const r = structuredClone(registry); change(r); assert.throws(() => validateRegistry(r), message); };
  bad(r => { r.collections[1].manifest = structuredClone(a); }, /Duplicate/);
  bad(r => { r.collections[1].label = 'Jobs Friday'; }, /Duplicate/);
  bad(r => { r.collections[0].label = 'x'; }, /entry/);
  bad(r => { r.collections[0].settlement = 'manual'; }, /entry/);
  bad(r => { r.collections[0].status = 'paused'; }, /entry/);
  bad(r => { r.collections[0].extra = true; }, /entry/);
  bad(r => { r.featured = c.pool; }, /featured/);
  bad(r => { r.featured = null; }, /featured/);
  bad(r => { r.pilotSettlement = 'sometimes'; }, /Invalid collection registry/);
  bad(r => { r.collections[0].manifest.rulesHash = '0x' + '00'.repeat(32); }, /./);
  bad(r => { r.collections[0].manifest = pilotFixture().manifest; }, /Unsupported collection mode/);
  // A large bond is refused only where the bot would sign approvals for it.
  const pricey = deterministicAt(0x41, '50000000');
  assert.throws(() => validateRegistry(registryOf([row(pricey, 'Pricey pool')])), /bond/);
  assert.doesNotThrow(() => validateRegistry(registryOf([row(pricey, 'Pricey pool', 'finish-only')])));
  const many = Array.from({ length: MAX_LISTED_COLLECTIONS + 1 }, (_, i) => row(deterministicAt(0x50 + 2 * i), `Pool number ${i}`, 'finish-only'));
  assert.throws(() => validateRegistry(registryOf(many)), /At most/);
});

test('registry mode is explicit, and the file is read and validated', async () => {
  assert.equal(registryEnabled({}), false);
  assert.equal(registryEnabled({ FLURBO_COLLECTIONS_SOURCE: '' }), false);
  assert.equal(registryEnabled({ FLURBO_COLLECTIONS_SOURCE: 'registry' }), true);
  assert.throws(() => registryEnabled({ FLURBO_COLLECTIONS_SOURCE: 'env' }), /registry/);
  const registry = registryOf([row(deterministicAt(0x11), 'Jobs Friday')]);
  assert.deepEqual(await loadRegistry({ read: async () => JSON.stringify(registry) }), registry);
  await assert.rejects(loadRegistry({ read: async () => JSON.stringify({ ...registry, schema: 'other' }) }), /Invalid/);
});

test('the site lists active registry collections only, featured as the registry says', async () => {
  const a = deterministicAt(0x11), b = deterministicAt(0x21), c = deterministicAt(0x31);
  const registry = registryOf([row(a, 'Jobs Friday'), row(b, 'Crypto weekend'), row(c, 'Old pool', 'finish-only', 'retired')], b.pool);
  const configured = await configurePracticeCollections({ env: { FLURBO_COLLECTIONS_SOURCE: 'registry', FLURBO_PRACTICE_COLLECTIONS_JSON: 'not used' },
    registry, rpcUrl: 'https://testnet-rpc.monad.xyz', command: async () => null });
  assert.deepEqual(configured.catalog.collections.map((r: any) => r.label), ['Jobs Friday', 'Crypto weekend']);
  assert.equal(configured.catalog.active, practiceNamespace(b.pool));
});

test('the worker plan: auto pools propose, finish-only pools finish, off pools are left alone, held pools only collect', () => {
  const a = deterministicAt(0x11), b = deterministicAt(0x21), c = deterministicAt(0x31), base = pilotFixture().manifest;
  const registry = validateRegistry(registryOf([row(a, 'Jobs Friday'), row(b, 'Crypto weekend', 'finish-only'), row(c, 'Old pool', 'off', 'retired')]));
  const plan = registryPlan({ registry, base, proposals: true, hold: heldPools({}) });
  assert.deepEqual(plan.map((p: any) => [p.manifest.pool, p.settlement, p.collects, p.proposing]),
    [[base.pool, 'finish-only', false, false], [a.pool, 'auto', true, true], [b.pool, 'finish-only', false, false]]);
  const held = registryPlan({ registry, base, proposals: true, hold: heldPools({ FLURBO_RESOLUTION_HOLD: ` ${a.pool.toUpperCase().replace('0X', '0x')} ` }) });
  assert.deepEqual(held.filter((p: any) => p.manifest.pool === a.pool).map((p: any) => [p.collects, p.proposing]), [[true, false]]);
  // Proposals off: nothing collects or proposes; deadlines are still finished.
  assert.ok(registryPlan({ registry, base, proposals: false, hold: new Set() }).every((p: any) => !p.collects && !p.proposing));
  assert.throws(() => registryPlan({ registry, base, proposals: true, hold: heldPools({ FLURBO_RESOLUTION_HOLD: hex(0x99, 20) }) }), /not registered/);
  assert.throws(() => heldPools({ FLURBO_RESOLUTION_HOLD: 'pool-a' }), /addresses/);
  assert.throws(() => registryPlan({ registry: { ...registry, pilotSettlement: 'auto', collections: [row(base, 'Same pool')] }, base, proposals: true, hold: new Set() }), /twice/);
  assert.equal(registryPlan({ registry, base: null, proposals: true, hold: new Set() }).length, 2);
});

test('idle pools: read by the monitor within ten minutes, nothing due for five more; anything else is read', () => {
  const at = 1_800_000_000;
  const schedule = new Map<string, any>([
    ['0x01', { checkedAt: at - 60, nextDueAt: at + 3600 }],
    ['0x02', { checkedAt: at - 60, nextDueAt: at + 120 }],
    ['0x03', { checkedAt: at - 900, nextDueAt: at + 3600 }],
    ['0x04', { checkedAt: at - 60, nextDueAt: 'none' }],
    ['0x05', { checkedAt: at - 60, nextDueAt: null }],
    ['0x06', { checkedAt: at + 60, nextDueAt: at + 3600 }],
  ]);
  assert.deepEqual([...idlePools(schedule, at)].sort(), ['0x01', '0x04']);
  assert.equal(idlePools(null, at).size, 0);
});

test('monitor cadence: a pool far from due is re-read every few minutes, a settled pool once, a due pool every cycle', () => {
  const at = 1_800_000_000;
  assert.equal(skipCheck({ checkedAt: at - 60, nextDueAt: at + 3600 }, at), true);
  assert.equal(skipCheck({ checkedAt: at - POOL_RECHECK_SECONDS, nextDueAt: at + 3600 }, at), false);
  assert.equal(skipCheck({ checkedAt: at - 60, nextDueAt: at + 600 }, at), false);
  assert.equal(skipCheck({ checkedAt: at - 60, nextDueAt: null }, at), false);
  assert.equal(skipCheck({ checkedAt: at - 99999, nextDueAt: 'none' }, at), true);
  assert.equal(skipCheck({ checkedAt: at + 30, nextDueAt: at + 3600 }, at), false, 'a clock moving backwards forces a read');
});

test('registry worker: every auto pool collects and may propose; a failing pool never stops the others; dry run never signs', async () => {
  // The fixture rules use the initial vintage with windows relative to the real clock, so they are collectable now.
  const now = Math.floor(Date.now() / 1000), a = deterministicAt(0x11), b = deterministicAt(0x21), c = deterministicAt(0x31);
  const registry = validateRegistry(registryOf([row(a, 'Jobs Friday'), row(b, 'Crypto weekend'), row(c, 'Weather', 'finish-only')]));
  const collected: string[] = [];
  const status = (m: any) => async () => ({ manifest: m, snapshot: { timestamp: now, blockNumber: '1', blockHash: '0x' + '11'.repeat(32) }, delivered: false,
    poolCash: '1', requiredCollateral: '1', cases: m.publication.draft.events.map(() => ({ phase: 0, assertionDeadline: String(now + 99999) })) });
  const result = await runResolution({ FLURBO_COLLECTIONS_SOURCE: 'registry', FLURBO_RESOLUTION_PROPOSALS: 'true', FLURBO_RESOLUTION_EXECUTE: 'false',
    FLURBO_RESOLUTION_SIGNER_ADDRESS: hex(0x12, 20), FLURBO_RESOLUTION_EVIDENCE_ORIGIN: 'https://flurbo.singu.online' }, {
    registry, baseManifest: null, now: () => now, rpc: async () => { throw Error('no chain reads in this test'); },
    command: async (op: string) => op === 'GET' ? null : 'OK', client: {}, transport: { sign: async () => assert.fail('dry run signed'), broadcast: async () => assert.fail('dry run broadcast') },
    archive: { put: async () => assert.fail('no archive'), get: async () => null },
    serviceFor: (m: any) => ({ status: status(m), prepare: async () => assert.fail('dry run prepared') }),
    sourcesFor: (m: any) => ({ collect: async () => { collected.push(m.pool); if (m.pool === a.pool) throw Error('source down'); return [{ event: 0, status: 'captured' }]; },
      proposal: async () => null, verifyPending: async () => null }),
    proposerHoldingsFor: () => async () => ({ clear: true, positions: [], wrapped: [], blockNumber: '1', checkedClaims: 0 }),
  });
  assert.equal(result.mode, 'registry');
  assert.equal(result.status, 'dry-run');
  assert.deepEqual(collected.sort(), [a.pool, b.pool].sort(), 'both auto pools collected; the finish-only pool did not');
  assert.deepEqual(result.sourceObservations, [{ pool: a.pool, status: 'collect-failed' }, { pool: b.pool, results: [{ event: 0, status: 'captured' }] }]);
  assert.deepEqual(result.pools.map((p: any) => p.pool), [a.pool, b.pool, c.pool]);
});
