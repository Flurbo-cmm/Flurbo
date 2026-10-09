import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { CATEGORY_BY_POOL, CATEGORY_ORDER, categorize, readBoardQuery, visibleCategories, writeBoardQuery } from '../src/market-categories.ts';

const config = async (name: string) => JSON.parse(await readFile(new URL('../../../config/' + name, import.meta.url), 'utf8'));

test('pilot and practice pools are classified by publication mode', () => {
  assert.equal(categorize({ pool: '0x' + 'aa'.repeat(20), kind: 'pilot', mode: 'rehearsal' }), 'practice');
  assert.equal(categorize({ pool: '0x' + 'aa'.repeat(20), kind: 'pilot', mode: 'ethereum-activity' }), 'crypto');
  assert.equal(categorize({ pool: '0x' + 'aa'.repeat(20), kind: 'pilot', mode: 'deterministic-source-v1' }), 'other');
});

test('unmapped oracle and hybrid pools are Other, and the explicit map wins over the mode', () => {
  assert.equal(categorize({ pool: '0x' + 'ab'.repeat(20), kind: 'oracle' }), 'other');
  assert.equal(categorize({ pool: '0x' + 'ab'.repeat(20), kind: 'hybrid' }), 'other');
  const mapped = Object.keys(CATEGORY_BY_POOL)[0];
  assert.equal(categorize({ pool: mapped.toUpperCase().replace('0X', '0x'), kind: 'pilot', mode: 'rehearsal' }), CATEGORY_BY_POOL[mapped]);
});

test('every registry pool has a category', async () => {
  const pools = [
    ...(await config('collections.json')).collections.map((c: any) => c.manifest.pool),
    ...(await config('oracle-markets.json')).routes.map((r: any) => r.pool),
    ...(await config('hybrid-markets.json')).pools.map((p: any) => p.pool),
  ].map((p: string) => p.toLowerCase());
  assert.ok(pools.length > 0);
  for (const pool of pools) assert.ok(CATEGORY_BY_POOL[pool], `${pool} needs a category in CATEGORY_BY_POOL`);
  for (const key of Object.keys(CATEGORY_BY_POOL)) assert.equal(key, key.toLowerCase());
});

test('visible categories hide empty ones, keep the fixed order and show Watchlist only when pinned', () => {
  const rows = [{ category: 'practice' as const }, { category: 'crypto' as const }, { category: 'practice' as const }];
  assert.deepEqual(visibleCategories(rows, 0).map(c => [c.slug, c.count]), [['all', 3], ['crypto', 1], ['practice', 2]]);
  assert.deepEqual(visibleCategories(rows, 2).map(c => [c.slug, c.count]), [['all', 3], ['watchlist', 2], ['crypto', 1], ['practice', 2]]);
  assert.deepEqual(visibleCategories([], 0).map(c => c.slug), ['all']);
  const order = visibleCategories(rows, 1).map(c => CATEGORY_ORDER.indexOf(c.slug));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.equal(visibleCategories(rows, 1)[1].label, 'Watchlist');
});

test('board query reads safely and writes only non-default values', () => {
  const defaults = { category: 'all', status: 'open', q: '', sort: 'closing', page: 1 };
  assert.deepEqual(readBoardQuery(''), defaults);
  assert.deepEqual(readBoardQuery('?category=nope&status=maybe&sort=random&page=-3'), defaults);
  assert.deepEqual(readBoardQuery('?page=2.5'), defaults);
  const query = readBoardQuery('?category=practice&status=all&q=night%20market&sort=name&page=3');
  assert.deepEqual(query, { category: 'practice', status: 'all', q: 'night market', sort: 'name', page: 3 });
  assert.equal(writeBoardQuery(defaults as any), '');
  assert.deepEqual(readBoardQuery(writeBoardQuery(query)), query);
  assert.equal(writeBoardQuery({ ...defaults, page: 2 } as any), '?page=2');
});
