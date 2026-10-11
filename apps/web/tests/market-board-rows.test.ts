import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBoardRows, filterBoardRows, rowFromSnapshot, toSnapshotRow } from '../src/market-board-rows.ts';
import { readBoardQuery } from '../src/market-categories.ts';

const now = 1_800_000_000_000, nowS = now / 1000;
const kleros = '0x' + '55'.repeat(20), night = '0xb5ce32de7a8631960dd26ab46bb20524d1ff9a44', archive = '0x' + '66'.repeat(20);
const hybrid = (pool: string, poolTitle: string, eventIndex: number, question: string, route: string, closesAt: number) =>
  ({ id: `${pool}-${eventIndex}`, pool, poolTitle, eventIndex, question, route, closesAt, observationEndsAt: closesAt + 900 });
const fixture = () => ({
  oracleMarkets: [
    { id: 'oracle-a-0', pool: '0x' + '44'.repeat(20), poolTitle: 'Source pool', eventIndex: 0, question: 'Will the block be even?', closesAt: nowS + 3600, observationEndsAt: nowS + 7200 },
    { id: 'oracle-a-1', pool: '0x' + '44'.repeat(20), poolTitle: 'Source pool', eventIndex: 1, question: 'Will the block contain a transaction?', closesAt: nowS + 3600, observationEndsAt: nowS + 7200 },
  ],
  oracleData: { 'oracle-a-0': { schema: 'flurbo.oracle-market.v1', id: 'oracle-a-0', pool: '0x' + '44'.repeat(20), marketNow: nowS - 5, funded: true, resolved: true, prices: { yes: '1000000', no: '0' } } } as any,
  hybridMarkets: [
    hybrid(kleros, 'Kleros challenge pool', 0, 'Will the first block contain a transaction?', 'mechanical', nowS + 900),
    hybrid(night, 'Night market pool', 0, 'Will the night market open?', 'reality', nowS + 7200),
    hybrid(night, 'Night market pool', 1, 'Will it rain on Saturday?', 'reality', nowS + 7200),
    hybrid(archive, 'Archive pool', 0, 'Will the archive night close?', 'mechanical', nowS - 60),
    hybrid(archive, 'Archive pool', 1, 'Will the archive rain stop?', 'mechanical', nowS - 60),
  ] as any,
  hybridData: {
    [`${kleros}-0`]: { schema: 'flurbo.hybrid-market.v1', id: `${kleros}-0`, pool: kleros, marketNow: nowS - 3, funded: false, resolved: false, prices: { yes: null, no: null } },
    [`${night}-0`]: { schema: 'flurbo.hybrid-market.v1', id: `${night}-0`, pool: night, marketNow: nowS - 10, funded: true, resolved: false, prices: { yes: '620000', no: '390000' } },
  } as any,
  now,
});
const keys = { a0: 'oracle:oracle-a-0', a1: 'oracle:oracle-a-1', k: `hybrid:${kleros}-0`, n0: `hybrid:${night}-0`, n1: `hybrid:${night}-1`, c0: `hybrid:${archive}-0`, c1: `hybrid:${archive}-1` };

test('rows keep the keys, statuses, links and notes of the directory, with no pilot rows', () => {
  const rows = buildBoardRows(fixture());
  assert.deepEqual(rows.map(r => r.key), [keys.a0, keys.a1, keys.k, keys.n0, keys.n1, keys.c0, keys.c1]);
  assert.ok(rows.every(r => r.kind === 'oracle' || r.kind === 'hybrid'));
  assert.deepEqual(rows.map(r => r.status), ['Settled', 'Open', 'Unavailable', 'Open', 'Open', 'Closed', 'Closed']);
  const [oracleA, oracleB, klerosRow, nightRow, rainRow] = rows;
  assert.equal(oracleA.href(), '/markets/oracle/oracle-a-0');
  assert.equal(oracleA.href(true), '/markets/oracle/oracle-a-0?answer=yes');
  assert.equal(klerosRow.href(false), `/markets/hybrid/${kleros}/0?answer=no`);
  assert.equal(rainRow.href(), `/markets/hybrid/${night}/1`);
  assert.deepEqual(nightRow.prices, { yes: '620000', no: '390000' });
  assert.equal(nightRow.priceAt, nowS - 10);
  assert.equal(rainRow.prices, null); assert.equal(rainRow.priceAt, null);
  assert.equal(oracleB.prices, null); assert.equal(oracleB.priceAt, null);
  assert.deepEqual([oracleA.combinable, klerosRow.combinable, nightRow.combinable], [true, false, true]);
  assert.deepEqual([oracleA.linkedCount, klerosRow.linkedCount, nightRow.linkedCount], [2, 1, 2]);
  assert.ok(rows.every(r => r.payoutNote === 'Results available. Open this market to collect eligible payouts.'));
  assert.deepEqual([oracleA.kindLabel, klerosRow.kindLabel, nightRow.kindLabel], ['Reality.eth + Kleros', 'Source verified, Kleros challenge', 'Reality.eth + Kleros']);
  assert.deepEqual([oracleA.category, klerosRow.category, nightRow.category], ['other', 'other', 'crypto']);
  assert.equal(nightRow.groupKey, `hybrid:${night}`); assert.equal(nightRow.groupLabel, 'Night market pool');
  assert.equal(oracleA.groupKey, 'oracle:' + '0x' + '44'.repeat(20));
});

test('a market without summary data keeps its row without prices', () => {
  const f = fixture();
  delete f.hybridData[`${kleros}-0`];
  const row = buildBoardRows(f).find(r => r.key === keys.k)!;
  assert.equal(row.status, 'Open'); assert.equal(row.prices, null); assert.equal(row.priceAt, null);
});

test('filters match the status, search and sort rules plus category and watchlist', () => {
  const rows = buildBoardRows(fixture());
  const q = (search: string) => readBoardQuery(search);
  assert.deepEqual(filterBoardRows(rows, q(''), new Set()).map(r => r.key), [keys.a1, keys.n0, keys.n1]);
  assert.deepEqual(filterBoardRows(rows, q('?status=closed'), new Set()).map(r => r.key), [keys.c0, keys.c1]);
  assert.deepEqual(filterBoardRows(rows, q('?status=settled'), new Set()).map(r => r.key), [keys.a0]);
  assert.deepEqual(filterBoardRows(rows, q('?status=all'), new Set()).map(r => r.status), ['Open', 'Open', 'Open', 'Closed', 'Closed', 'Unavailable', 'Settled']);
  assert.deepEqual(filterBoardRows(rows, q('?status=all&q=RAIN'), new Set()).map(r => r.key), [keys.n1, keys.c1]);
  assert.deepEqual(filterBoardRows(rows, q('?sort=name'), new Set()).map(r => r.question), ['Will it rain on Saturday?', 'Will the block contain a transaction?', 'Will the night market open?']);
  assert.deepEqual(filterBoardRows(rows, q('?category=crypto&status=all'), new Set()).map(r => r.key), [keys.n0, keys.n1]);
  assert.deepEqual(filterBoardRows(rows, q('?category=watchlist'), new Set([keys.c1, keys.a1])).map(r => r.key), [keys.a1, keys.c1]);
});

test('snapshot rows round trip without functions and rebuild the same links', () => {
  const rows = buildBoardRows(fixture());
  for (const row of rows) {
    const copy = rowFromSnapshot(JSON.parse(JSON.stringify(toSnapshotRow(row))));
    assert.equal(copy.key, row.key);
    for (const yes of [undefined, true, false]) assert.equal(copy.href(yes), row.href(yes));
  }
});
