import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readHistoryCache, writeHistoryCache } from '../src/portfolio-history-cache.ts';

const owner = '0x' + '11'.repeat(20), stranger = '0x' + '77'.repeat(20), pool = '0x' + '44'.repeat(20);
const namespace = ('hybrid-' + pool) as `hybrid-0x${string}`;
const group = { kind: 'hybrid' as const, namespace, label: 'Pool', pool, closesAt: 1 };
const log = (index: number, trader: string, name = 'Traded') => ({ name, hash: '0x' + String(index).repeat(64), index, block: 100 + index,
  timestamp: 1000 + index, args: { trader, owner: trader, scope: 1, mask: '2', isBuy: true, quantity: '1000000', collateralAmount: '500000' } });
const read = (extra: object = {}) => ({ group, owners: {}, blocks: {}, holdingsComplete: true,
  history: { complete: true, through: 200, target: 200, logs: [log(1, owner), log(2, stranger), log(3, owner, 'Redeemed')] },
  payouts: { complete: true, through: 200, target: 200, logs: [log(3, owner, 'Redeemed'), log(4, stranger, 'Redeemed')] }, ...extra });

function withStorage(run: (db: Map<string, string>) => void) {
  const db = new Map<string, string>(), previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => db.get(key) ?? null,
    setItem: (key: string, value: string) => db.set(key, value), removeItem: (key: string) => db.delete(key) } });
  try { run(db); } finally { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete (globalThis as any).localStorage; }
}

test('past activity is cached per account, keeps only the account wallets and marks itself as cached', () => {
  withStorage(db => {
    writeHistoryCache('0xacc', owner, namespace, read() as any, 5000);
    const stored = [...db.values()].join('');
    assert.ok(!stored.includes(stranger.slice(2)));
    const cached = readHistoryCache('0xacc', owner, 6000);
    assert.equal(cached[namespace].history!.logs.length, 2);
    assert.equal(cached[namespace].payouts!.logs.length, 1);
    assert.equal(cached[namespace].history!.complete, true);
    assert.equal(cached[namespace].savedAt, 5000);
    assert.deepEqual(readHistoryCache('0xother', owner, 6000), {});
    assert.deepEqual(readHistoryCache('0xacc', owner + ',' + stranger, 6000), {});
  });
});

test('a failed or empty read never replaces saved activity, and stale or malformed entries are dropped', () => {
  withStorage(db => {
    writeHistoryCache('0xacc', owner, namespace, read() as any, 5000);
    writeHistoryCache('0xacc', owner, namespace, read({ history: undefined, payouts: undefined, historyError: true }) as any, 6000);
    assert.equal(readHistoryCache('0xacc', owner, 7000)[namespace].history!.logs.length, 2);
    assert.deepEqual(readHistoryCache('0xacc', owner, 5000 + 31 * 86_400_000), {});
    const key = [...db.keys()][0];
    db.set(key, JSON.stringify({ identity: owner, pools: { [namespace]: { savedAt: 5000, pool, history: { complete: true, logs: [{ name: 'Traded', hash: 'bad' }] } } } }));
    assert.deepEqual(readHistoryCache('0xacc', owner, 6000), {});
    db.set(key, 'broken');
    assert.deepEqual(readHistoryCache('0xacc', owner, 6000), {});
  });
});

test('blocked storage never breaks the portfolio', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw Error('blocked'); } });
  try {
    assert.doesNotThrow(() => writeHistoryCache('0xacc', owner, namespace, read() as any));
    assert.deepEqual(readHistoryCache('0xacc', owner), {});
  } finally { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete (globalThis as any).localStorage; }
});
