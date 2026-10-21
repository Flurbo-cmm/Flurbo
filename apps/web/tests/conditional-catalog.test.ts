import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { conditionalCatalog } from '../server/conditional-market-service.mjs';
import { hybridSettlementCatalog } from '../server/hybrid-settlement-worker.mjs';
import { account, hybridRecord } from './hybrid-catalog-fixture.ts';

const pricer = account('c');
const record = (n: number, extra: Record<string, unknown> = {}) => ({ ...hybridRecord({ commissionBps: 500,
  pool: `0x${n.toString(16).padStart(40, 'a')}`, resolver: `0x${n.toString(16).padStart(40, 'b')}` }),
  id: `cond-${n}`, conditionalVersion: 1, ...extra });
const catalog = (pools: unknown[], extra: Record<string, unknown> = {}) =>
  ({ schema: 'flurbo.conditional-catalog.v1', pricer, pools, ...extra });

test('an empty conditional catalog is valid and changes nothing', async () => {
  const empty = { schema: 'flurbo.conditional-catalog.v1', pricer: null, pools: [] };
  assert.equal(conditionalCatalog(empty), empty);
  assert.deepEqual(conditionalCatalog(catalog([])).pools, []);
  const committed = JSON.parse(await readFile(new URL('../../../config/conditional-markets.json', import.meta.url), 'utf8'));
  assert.deepEqual(committed, empty);
  for (const bad of [null, {}, { ...empty, schema: 'flurbo.hybrid-catalog.v1' }, { ...empty, pricer: 'nope' },
    { ...empty, pools: {} }, { ...empty, extra: true }])
    assert.throws(() => conditionalCatalog(bad), /Invalid conditional catalog/);
});

test('a conditional record is a hybrid record plus conditionalVersion', () => {
  assert.equal(conditionalCatalog(catalog([record(1)])).pools.length, 1);
  const { conditionalVersion, ...plain } = record(1);
  assert.equal(conditionalVersion, 1);
  const v4 = { ...hybridRecord({ pool: account('d'), resolver: account('e') }), id: 'cond-v4', conditionalVersion: 1 };
  for (const pools of [[plain], [record(1, { conditionalVersion: 2 })], [v4], [record(1), record(1)],
    [record(1), { ...record(2), pool: record(1).pool }], Array.from({ length: 9 }, (_, i) => record(i + 1))])
    assert.throws(() => conditionalCatalog(catalog(pools)), /Invalid conditional catalog/);
  assert.throws(() => conditionalCatalog({ schema: 'flurbo.conditional-catalog.v1', pricer: null, pools: [record(1)] }),
    /Invalid conditional catalog/);
  assert.equal(conditionalCatalog(catalog(Array.from({ length: 8 }, (_, i) => record(i + 1)))).pools.length, 8);
});

test('hybrid and conditional pools together are at most 16', () => {
  const hybrid = Array.from({ length: 8 }, (_, i) => ({ ...hybridRecord({ commissionBps: 500,
    pool: `0x${(i + 1).toString(16).padStart(40, 'c')}`, resolver: `0x${(i + 1).toString(16).padStart(40, 'd')}` }), id: `hybrid-${i}` }));
  const conditional = conditionalCatalog(catalog(Array.from({ length: 8 }, (_, i) => record(i + 1)))).pools;
  assert.equal(hybridSettlementCatalog({ schema: 'flurbo.hybrid-catalog.v1', pools: [...hybrid, ...conditional] }).pools.length, 16);
  const extra = { ...hybridRecord({ commissionBps: 500, pool: account('f'), resolver: account('e') }), id: 'hybrid-extra' };
  assert.throws(() => hybridSettlementCatalog({ schema: 'flurbo.hybrid-catalog.v1', pools: [...hybrid, extra, ...conditional] }),
    /Invalid hybrid catalog/);
  assert.throws(() => hybridSettlementCatalog({ schema: 'flurbo.hybrid-catalog.v1',
    pools: [{ ...hybrid[0], pool: conditional[0].pool }, ...conditional] }), /Invalid hybrid pool/);
});
