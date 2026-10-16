import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchLinkedPrices } from '../src/linked-prices.ts';

const ids = ['a', 'b', 'c', 'd', 'e', 'f'];

test('linked prices are read live and fall back to the cached price when a read fails', async () => {
  const result = await fetchLinkedPrices(ids, async id => {
    if (id === 'b') throw Error('down');
    if (id === 'c') return { prices: { yes: 'not a number', no: null } };
    return { prices: { yes: id === 'a' ? '552000' : '527000', no: '500000' } };
  }, id => id === 'b' ? '510000' : null);
  assert.equal(result.a, '552000');
  assert.equal(result.b, '510000');
  assert.equal(result.c, null);
  assert.equal(result.d, '527000');
});

test('linked price reads never run more than the concurrency limit at once', async () => {
  let active = 0, peak = 0;
  await fetchLinkedPrices(ids, async () => {
    active += 1; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
    return { prices: { yes: '1', no: '1' } };
  }, () => null, 2);
  assert.ok(peak <= 2, `peak ${peak}`);
});

test('a stopped read does not report prices', async () => {
  const controller = new AbortController();
  const pending = fetchLinkedPrices(ids, async () => { controller.abort(); return { prices: { yes: '1', no: '1' } }; }, () => null, 1, controller.signal);
  const result = await pending;
  assert.ok(Object.keys(result).length < ids.length);
});
