import assert from 'node:assert/strict';
import test from 'node:test';
import { readBalance, formatAmount } from './balance.ts';
const target = { chainId: 10143, decimals: 6, rpcUrl: 'https://rpc.example', token: '0x' + '22'.repeat(20) };
const owner = '0x' + '11'.repeat(20), hash = '0x' + 'aa'.repeat(32);
function fixture(transform = (_method: string, result: unknown) => result) {
  const calls: any[] = [];
  const fetcher = (async (_url, init) => {
    const body = JSON.parse(init!.body as string); calls.push(body);
    const { method, params, id } = body;
    const result = method === 'eth_chainId' ? '0x279f' : method === 'eth_getBlockByNumber' ? { number: '0x100', hash }
      : method === 'eth_getCode' ? '0x6000' : method === 'eth_getBalance' ? '0xde0b6b3a7640000'
      : params[0].data === '0x313ce567' ? '0x6' : '0xf4240';
    return Response.json({ jsonrpc: '2.0', id, result: transform(method, result) });
  }) as typeof fetch;
  return { calls, fetcher };
}
test('reads actual AUSD and MON at one canonical snapshot without signing', async () => {
  const f = fixture(), value = await readBalance(target, owner, undefined, f.fetcher);
  assert.equal(value.ausd, '1000000'); assert.equal(value.mon, '1000000000000000000');
  for (const c of f.calls.filter(c => ['eth_call', 'eth_getBalance', 'eth_getCode'].includes(c.method))) assert.equal(c.params.at(-1), '0x100');
  assert.ok(f.calls.every(c => !c.method.includes('send')));
});
test('rejects wrong chain, missing code, wrong decimals and reorg', async () => {
  for (const transform of [
    (m: string, v: unknown) => m === 'eth_chainId' ? '0x8f' : v,
    (m: string, v: unknown) => m === 'eth_getCode' ? '0x' : v,
    (m: string, v: unknown) => m === 'eth_call' ? '0x12' : v,
  ]) await assert.rejects(readBalance(target, owner, undefined, fixture(transform).fetcher), /Could not refresh/);
  let blocks = 0;
  await assert.rejects(readBalance(target, owner, undefined, fixture((m, v) => m === 'eth_getBlockByNumber' && ++blocks === 2 ? { number: '0x100', hash: '0x' + 'bb'.repeat(32) } : v).fetcher));
});
test('formatting preserves large integer amounts without Number conversion', () => {
  assert.equal(formatAmount('999999999999999999123456', 6), '999,999,999,999,999,999.123456');
  assert.equal(formatAmount('0', 6), '0'); assert.equal(formatAmount('1', 6), '0.000001');
});
