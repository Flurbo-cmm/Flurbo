import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBoardRows, filterBoardRows, rowFromSnapshot, toSnapshotRow } from '../src/market-board-rows.ts';
import { readBoardQuery } from '../src/market-categories.ts';

const now = 1_800_000_000_000, nowS = now / 1000;
const practicePool = '0x' + '22'.repeat(20), practice = `practice-${'22'.repeat(20)}`;
const snapshot = (mode: string, closesAt: number, extra: Record<string, unknown> = {}) => ({
  manifest: { pool: practicePool, publication: { mode, draft: { closesAt, events: [{ id: 'night', question: 'Will the night market open?' }, { id: 'rain', question: 'Will it rain on Saturday?' }] } } },
  snapshot: { timestamp: nowS - 10 }, open: true, resolved: false,
  prices: [{ event: 0, yes: '620000', no: '390000' }, { event: 1, yes: null, no: null }], ...extra,
});
const fixture = () => ({
  groups: [{ namespace: practice, label: 'October practice', pool: practicePool, closesAt: nowS + 7200 }, { namespace: 'pilot', label: 'Example markets', pool: '0x' + '33'.repeat(20), closesAt: nowS - 60 }] as any,
  data: { [practice]: snapshot('rehearsal', nowS + 7200), pilot: { ...snapshot('ethereum-activity', nowS - 60), manifest: { ...snapshot('ethereum-activity', nowS - 60).manifest, pool: '0x' + '33'.repeat(20) } } } as any,
  oracleMarkets: [
    { id: 'oracle-a-0', pool: '0x' + '44'.repeat(20), poolTitle: 'Source pool', eventIndex: 0, question: 'Will the block be even?', closesAt: nowS + 3600, observationEndsAt: nowS + 7200 },
    { id: 'oracle-a-1', pool: '0x' + '44'.repeat(20), poolTitle: 'Source pool', eventIndex: 1, question: 'Will the block contain a transaction?', closesAt: nowS + 3600, observationEndsAt: nowS + 7200 },
  ],
  oracleData: { 'oracle-a-0': { schema: 'flurbo.oracle-market.v1', id: 'oracle-a-0', pool: '0x' + '44'.repeat(20), marketNow: nowS - 5, funded: true, resolved: true, prices: { yes: '1000000', no: '0' } } } as any,
  hybridMarkets: [{ id: '0x' + '55'.repeat(20) + '-0', pool: '0x' + '55'.repeat(20), poolTitle: 'Kleros challenge pool', eventIndex: 0, question: 'Will the first block contain a transaction?', route: 'mechanical', closesAt: nowS + 900, observationEndsAt: nowS + 1800 }] as any,
  hybridData: { ['0x' + '55'.repeat(20) + '-0']: { schema: 'flurbo.hybrid-market.v1', id: '0x' + '55'.repeat(20) + '-0', pool: '0x' + '55'.repeat(20), marketNow: nowS - 3, funded: false, resolved: false, prices: { yes: null, no: null } } } as any,
  now,
});

test('rows keep the keys, statuses, links and notes of the original directory', () => {
  const rows = buildBoardRows(fixture());
  assert.deepEqual(rows.map(r => r.key), [practice + 'night', practice + 'rain', 'pilotnight', 'pilotrain', 'oracle:oracle-a-0', 'oracle:oracle-a-1', 'hybrid:' + '0x' + '55'.repeat(20) + '-0']);
  assert.deepEqual(rows.map(r => r.status), ['Open', 'Open', 'Closed', 'Closed', 'Settled', 'Open', 'Unavailable']);
  const [night, rain, pilot, , oracleA, oracleB, hybrid] = rows;
  assert.equal(night.href(), `/markets/${practice}/0`);
  assert.equal(night.href(true), `/markets/${practice}/0`);
  assert.equal(night.href(false), `/markets/${practice}/0?answer=no`);
  assert.equal(rain.href(false), `/markets/${practice}/1?answer=no`);
  assert.equal(oracleA.href(), '/markets/oracle/oracle-a-0');
  assert.equal(oracleA.href(true), '/markets/oracle/oracle-a-0?answer=yes');
  assert.equal(hybrid.href(false), `/markets/hybrid/${'0x' + '55'.repeat(20)}/0?answer=no`);
  assert.deepEqual(night.prices, { yes: '620000', no: '390000' });
  assert.deepEqual(rain.prices, { yes: null, no: null });
  assert.equal(night.priceAt, nowS - 10);
  assert.equal(oracleB.prices, null);
  assert.equal(oracleB.priceAt, null);
  assert.deepEqual([night.combinable, oracleA.combinable, hybrid.combinable], [true, true, false]);
  assert.deepEqual([night.linkedCount, oracleA.linkedCount, hybrid.linkedCount], [2, 2, 1]);
  assert.equal(night.payoutNote, 'Results available. Collect eligible payouts in Portfolio.');
  assert.equal(oracleA.payoutNote, 'Results available. Open this market to collect eligible payouts.');
  assert.deepEqual([night.kindLabel, pilot.kindLabel, oracleA.kindLabel, hybrid.kindLabel], ['Practice', 'Ethereum', 'Reality.eth + Kleros', 'Source verified, Kleros challenge']);
  assert.deepEqual([night.category, pilot.category, oracleA.category], ['practice', 'crypto', 'other']);
  assert.equal(night.groupKey, practice);
  assert.equal(oracleA.groupKey, 'oracle:' + '0x' + '44'.repeat(20));
  assert.equal(night.groupLabel, 'October practice');
});

test('missing pool data hides only that pool', () => {
  const f = fixture();
  delete (f.data as any)[practice];
  const keys = buildBoardRows(f).map(r => r.key);
  assert.ok(!keys.some(k => k.startsWith(practice)));
  assert.ok(keys.includes('pilotnight'));
});

test('filters match the original status, search and sort rules plus category and watchlist', () => {
  const rows = buildBoardRows(fixture());
  const q = (search: string) => readBoardQuery(search);
  assert.deepEqual(filterBoardRows(rows, q(''), new Set()).map(r => r.key), ['oracle:oracle-a-1', practice + 'night', practice + 'rain']);
  assert.deepEqual(filterBoardRows(rows, q('?status=closed'), new Set()).map(r => r.key), ['pilotnight', 'pilotrain']);
  assert.deepEqual(filterBoardRows(rows, q('?status=settled'), new Set()).map(r => r.key), ['oracle:oracle-a-0']);
  const all = filterBoardRows(rows, q('?status=all'), new Set()).map(r => r.status);
  assert.deepEqual(all, ['Open', 'Open', 'Open', 'Closed', 'Closed', 'Unavailable', 'Settled']);
  assert.deepEqual(filterBoardRows(rows, q('?status=all&q=RAIN'), new Set()).map(r => r.key), [practice + 'rain', 'pilotrain']);
  assert.deepEqual(filterBoardRows(rows, q('?sort=name'), new Set()).map(r => r.question), ['Will it rain on Saturday?', 'Will the block contain a transaction?', 'Will the night market open?']);
  assert.deepEqual(filterBoardRows(rows, q('?category=practice&status=all'), new Set()).map(r => r.key), [practice + 'night', practice + 'rain']);
  assert.deepEqual(filterBoardRows(rows, q('?category=watchlist'), new Set(['pilotrain', 'oracle:oracle-a-1'])).map(r => r.key), ['oracle:oracle-a-1', 'pilotrain']);
});

test('snapshot rows round trip without functions and rebuild the same links', () => {
  const rows = buildBoardRows(fixture());
  for (const row of rows) {
    const copy = rowFromSnapshot(JSON.parse(JSON.stringify(toSnapshotRow(row))));
    assert.equal(copy.key, row.key);
    for (const yes of [undefined, true, false]) assert.equal(copy.href(yes), row.href(yes));
  }
});
