import test from 'node:test';
import assert from 'node:assert/strict';
import { submitTracked, checkTracked, type TrackedCall } from './tracked-call.ts';
const tx = { from: '0x' + '1'.repeat(40), to: '0x' + '2'.repeat(40), data: '0x12345678', chainId: '0x279f', value: '0x0' };
const hash = '0x' + 'a'.repeat(64);
test('durable pending save precedes signing, and the returned hash is saved before success', async () => {
  let disk: TrackedCall | null = null, memory: TrackedCall | null = null, sends = 0;
  await submitTracked({ async request({ method }) { if (method === 'eth_getTransactionCount') return 7; sends++; assert.equal(disk?.nonce, '0x7'); assert.equal(disk?.hash, null); return hash; } }, tx, () => true, v => { memory = v; }, async () => { disk = JSON.parse(JSON.stringify(memory)); });
  assert.equal(sends, 1); assert.equal((disk as TrackedCall | null)?.hash, hash);
});
test('failed storage and an account change during the save cannot open a wallet prompt', async () => {
  let sends = 0, current = true, pending: TrackedCall | null = null;
  const p = { async request({ method }: { method: string }) { if (method === 'eth_getTransactionCount') return '0x7'; sends++; return hash; } };
  await assert.rejects(submitTracked(p, tx, () => true, v => { pending = v; }, async () => { throw new Error('disk full'); }));
  await assert.rejects(submitTracked(p, tx, () => current, v => { pending = v; }, async () => { current = false; }));
  assert.equal(sends, 0); assert.equal(pending, null);
});
test('ambiguous sends preserve tracking across restart, explicit rejection clears it', async () => {
  for (const code of [undefined, 4001]) {
    let pending: TrackedCall | null = null;
    await assert.rejects(submitTracked({ async request({ method }) { if (method === 'eth_getTransactionCount') return '0x7'; throw { code }; } }, tx, () => true, v => { pending = v; }, async () => {}));
    assert.equal(pending === null, code === 4001);
  }
});
test('confirmation rejects a different transaction and waits for a canonical follow-up block', async () => {
  const saved = { tx, nonce: '0x7', hash, started: 1 };
  let found = { ...tx, hash, nonce: '0x7', input: tx.data, blockHash: hash, blockNumber: '0x10' }, head = '0x10';
  const p = { async request({ method, params }: { method: string; params?: unknown[] }) {
    if (method === 'eth_getTransactionByHash') return found;
    if (method === 'eth_getTransactionReceipt') return { transactionHash: hash, blockHash: hash, blockNumber: '0x10', status: '0x1' };
    return params?.[0] === 'latest' ? { number: head, hash } : { hash };
  } };
  assert.equal(await checkTracked(p, saved), 'confirming');
  head = '0x11'; assert.equal(await checkTracked(p, saved), 'confirmed');
  found = { ...found, input: '0xaabbccdd' }; await assert.rejects(checkTracked(p, saved), /differs/);
});
