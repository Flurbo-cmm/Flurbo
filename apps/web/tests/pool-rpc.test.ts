import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFunctionData, encodeFunctionResult, parseAbi } from 'viem';
import { poolRpc } from '../server/pool-rpc.mjs';
import { pilotPoolAbi } from '../shared/pilot.mjs';

const pool = '0x' + '22'.repeat(20);
const aggregateAbi = parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)']);
const answering = (rows: (calls: any[]) => any[]) => async (_url: any, init: any) => {
  const input = JSON.parse(init.body), calls = decodeFunctionData({ abi: aggregateAbi, data: input.params[0].data }).args[0] as any[];
  return Response.json({ jsonrpc: '2.0', id: input.id, result: encodeFunctionResult({ abi: aggregateAbi, functionName: 'aggregate3', result: rows(calls) }) });
};

test('pool RPC accepts only public testnet read endpoints and validates response identity', async () => {
  assert.throws(() => poolRpc('http://localhost:8545'));
  const rpc = poolRpc('https://testnet-rpc.monad.xyz', async (_url: any, init: any) => { const input = JSON.parse(init.body); return Response.json({ jsonrpc: '2.0', id: input.id, result: '0x279f' }); });
  assert.equal(await rpc('eth_chainId', []), '0x279f');
  await assert.rejects(rpc('eth_sendRawTransaction', ['0x00']), /Pool service is read-only/);
  await assert.rejects(poolRpc('https://testnet-rpc.monad.xyz', async () => Response.json({ jsonrpc: '2.0', id: 99, result: '0x279f' }))('eth_chainId', []), /Pool RPC rejected the read/);
});

test('log range errors are classified without exposing upstream details; transport failures are not range errors', async () => {
  const rejected = (message: string, status = 200) => poolRpc('https://monad-testnet.g.alchemy.com/v2/test-key', async (_url: any, init: any) => Response.json({ jsonrpc: '2.0', id: JSON.parse(init.body).id, error: { code: -32602, message } }, { status }));
  await assert.rejects(rejected('eth_getLogs block range limit: secret-key')('eth_getLogs', []), (e: any) => e.code === 'LOG_RANGE_LIMIT' && !e.message.includes('secret-key'));
  await assert.rejects(rejected('eth_getLogs block range limit: secret-key', 400)('eth_getLogs', []), (e: any) => e.code === 'LOG_RANGE_LIMIT' && !e.message.includes('secret-key'));
  await assert.rejects(rejected('rate limit reached')('eth_getLogs', []), (e: any) => e.code === undefined);
  await assert.rejects(rejected('block range limit')('eth_call', []), (e: any) => e.code === undefined);
  await assert.rejects(rejected('block range limit', 429)('eth_getLogs', []), (e: any) => e.code === undefined);
});

test('a QuickNode Monad testnet endpoint is accepted everywhere the server reads the chain, and its token never leaks', async () => {
  const { testnetRpcHost, hostedConfig } = await import('../server/network.mjs');
  const { agentRpc } = await import('../server/agents/agent-market.mjs');
  const { learningRpc } = await import('../server/learning-pool.mjs');
  const quicknode = 'https://little-dawn-cloud.monad-testnet.quiknode.pro/secret-token-123/';
  for (const host of ['testnet-rpc.monad.xyz', 'monad-testnet.g.alchemy.com', 'little-dawn-cloud.monad-testnet.quiknode.pro']) assert.equal(testnetRpcHost(host), true, host);
  for (const host of ['x.monad-mainnet.quiknode.pro', 'a.b.monad-testnet.quiknode.pro', 'monad-testnet.quiknode.pro.evil.com', 'evil.com']) assert.equal(testnetRpcHost(host), false, host);
  assert.throws(() => poolRpc('https://x.monad-mainnet.quiknode.pro/token/'), /testnet RPC required/);
  agentRpc(quicknode); learningRpc(quicknode);
  assert.equal(hostedConfig({ FLURBO_ORIGIN: 'https://flurbo.singu.online', FLURBO_NETWORK: 'public_testnet', FLURBO_ALCHEMY_TESTNET_RPC_URL: quicknode }).rpcUrl, quicknode);
  const rpc = poolRpc(quicknode, async () => new Response('upstream said secret-token-123', { status: 500 }));
  await assert.rejects(rpc('eth_chainId', []), (e: Error) => !String(e.message).includes('secret-token-123'));
});

test('read batches go through one Multicall3 call, are bounded, and fail whole when one read fails', async () => {
  const call = { to: pool, abi: pilotPoolAbi, fn: 'eventCount', args: [] };
  const ok = poolRpc('https://testnet-rpc.monad.xyz', answering(calls => calls.map(() => ({ success: true, returnData: encodeFunctionResult({ abi: pilotPoolAbi, functionName: 'eventCount', result: 2 }) }))));
  assert.deepEqual(await ok.readBatch([call, call], '0x64'), [2, 2]);
  await assert.rejects(ok.readBatch(Array.from({ length: 61 }, () => call), '0x64'), /Read batch too large/);
  const partial = poolRpc('https://testnet-rpc.monad.xyz', answering(calls => calls.map((_, i) => i === 1 ? { success: false, returnData: '0x' }
    : { success: true, returnData: encodeFunctionResult({ abi: pilotPoolAbi, functionName: 'eventCount', result: 2 }) })));
  await assert.rejects(partial.readBatch([call, call, call], '0x64'), /Incomplete read batch/);
});
