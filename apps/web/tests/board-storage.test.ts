import assert from 'node:assert/strict';
import { test } from 'node:test';
import { directoryHash, readBoardSnapshot, writeBoardSnapshot } from '../src/board-cache.ts';
import { priceDelta, readSeen, writeSeen } from '../src/price-memory.ts';
import { readWatchlist, toggleWatchlist } from '../src/watchlist.ts';

function memory(): Storage {
  const data = new Map<string, string>();
  return { get length() { return data.size; }, clear: () => data.clear(), key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, String(v)); }, removeItem: (k: string) => { data.delete(k); } } as Storage;
}
const broken = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); }, removeItem() { throw Error('blocked'); }, key: () => null, length: 0, clear() {} } as unknown as Storage;
const alice = '0x' + 'ab'.repeat(20), bob = '0x' + 'cd'.repeat(20);
const row = { key: 'k1', groupKey: 'g', groupLabel: 'Pool', category: 'crypto', kind: 'pilot', path: '/markets/pilot/0', kindLabel: 'Ethereum', question: 'Q?', closesAt: 1, status: 'Open', prices: { yes: '1', no: '2' }, priceAt: 5, combinable: false, linkedCount: 1, payoutNote: '' } as const;

test('board snapshot round trips per account and tolerates bad storage', () => {
  const s = memory();
  writeBoardSnapshot(alice, { directoryHash: 'h1', rows: [row as any] }, 1000, s);
  assert.deepEqual(readBoardSnapshot(alice, s), { savedAt: 1000, directoryHash: 'h1', rows: [row] });
  assert.equal(readBoardSnapshot(bob, s), null);
  assert.equal(readBoardSnapshot(alice.toUpperCase().replace('0X', '0x'), s)?.directoryHash, 'h1');
  s.setItem('flurbo.board.v1:' + alice, '{not json');
  assert.equal(readBoardSnapshot(alice, s), null);
  s.setItem('flurbo.board.v1:' + alice, JSON.stringify({ savedAt: 'x', rows: 4 }));
  assert.equal(readBoardSnapshot(alice, s), null);
  assert.doesNotThrow(() => writeBoardSnapshot(alice, { directoryHash: 'h', rows: [] }, 1, broken));
  assert.equal(readBoardSnapshot(alice, broken), null);
});

test('directory hash changes when the directory changes', () => {
  const a = { agentPools: [{ namespace: 'practice-' + '11'.repeat(20), pool: '0x1', label: 'A', closesAt: 1 }], oracleMarkets: [], hybridMarkets: [] } as any;
  assert.equal(directoryHash(a), directoryHash(JSON.parse(JSON.stringify(a))));
  assert.notEqual(directoryHash(a), directoryHash({ ...a, agentPools: [{ ...a.agentPools[0], closesAt: 2 }] }));
});

test('price deltas ignore changes under 0.005 and carry a direction', () => {
  assert.equal(priceDelta('620000', '624999'), null);
  assert.deepEqual(priceDelta('620000', '625000'), { atoms: 5000n, direction: 'up' });
  assert.deepEqual(priceDelta('620000', '580000'), { atoms: -40000n, direction: 'down' });
  assert.equal(priceDelta(null, '600000'), null);
  assert.equal(priceDelta('600000', undefined), null);
  assert.equal(priceDelta('bad', '600000'), null);
});

test('seen prices round trip per account and tolerate bad storage', () => {
  const s = memory();
  writeSeen(alice, { k1: { yes: '620000', no: '390000' } }, 5000, s);
  assert.deepEqual(readSeen(alice, s), { savedAt: 5000, prices: { k1: { yes: '620000', no: '390000' } } });
  assert.equal(readSeen(bob, s), null);
  assert.doesNotThrow(() => writeSeen(alice, {}, 1, broken));
  assert.equal(readSeen(alice, broken), null);
});

test('watchlist toggles, caps at 200 newest and stays per account', () => {
  const s = memory();
  assert.deepEqual([...toggleWatchlist(alice, 'a', s)], ['a']);
  assert.deepEqual([...toggleWatchlist(alice, 'b', s)], ['a', 'b']);
  assert.deepEqual([...toggleWatchlist(alice, 'a', s)], ['b']);
  assert.deepEqual([...readWatchlist(bob, s)], []);
  for (let i = 0; i < 205; i++) toggleWatchlist(bob, 'm' + i, s);
  const list = [...readWatchlist(bob, s)];
  assert.equal(list.length, 200);
  assert.equal(list[0], 'm5');
  assert.equal(list[199], 'm204');
  assert.deepEqual([...readWatchlist(alice, broken)], []);
  assert.doesNotThrow(() => toggleWatchlist(alice, 'x', broken));
});
