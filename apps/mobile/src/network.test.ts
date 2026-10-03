import assert from 'node:assert/strict';
import test from 'node:test';
import { checkConnection } from './network.ts';

const target = { chainId: 10143, rpcUrl: 'https://example.invalid' };

function rpcResponse(id: number, result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

test('checks the chain before reading a block using read-only RPCs', async () => {
  const methods: string[] = [];
  const request = (async (_url, init) => {
    const body = JSON.parse(init?.body as string);
    methods.push(body.method);
    assert.deepEqual(body.params, []);
    return rpcResponse(body.id, body.id === 1 ? '0x279f' : '0x100');
  }) as typeof fetch;
  const result = await checkConnection(target, request);
  assert.equal(result.blockNumber, 256);
  assert.ok(result.checkedAt <= Date.now());
  assert.deepEqual(methods, ['eth_chainId', 'eth_blockNumber']);
});

test('stops on the wrong chain and never reads a block', async () => {
  let calls = 0;
  await assert.rejects(checkConnection(target, (async () => {
    calls++;
    return rpcResponse(1, '0x8f');
  }) as typeof fetch), /Could not verify Monad testnet/);
  assert.equal(calls, 1);
});

test('rejects HTTP, malformed, RPC-error, and invalid block responses without remote text', async () => {
  for (const response of [new Response('secret', { status: 503 }), new Response('not JSON: secret'),
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'secret' } })),
    rpcResponse(9, '0x279f'), rpcResponse(1, 'not hex'), rpcResponse(1, '0xffffffffffffffff')]) {
    await assert.rejects(checkConnection(target, (async () => response) as typeof fetch), (error: Error) => {
      assert.equal(error.message, 'Could not verify Monad testnet. Check your connection and try again.');
      return true;
    });
  }
  for (const block of ['0x0', '0xffffffffffffffff', null]) {
    await assert.rejects(checkConnection(target, (async (_url, init) => {
      const { id } = JSON.parse(init?.body as string);
      return rpcResponse(id, id === 1 ? '0x279f' : block);
    }) as typeof fetch));
  }
});

test('turns aborted or failed requests into a retryable message', async () => {
  await assert.rejects(checkConnection(target, (async (_url, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    throw new DOMException('remote detail', 'AbortError');
  }) as typeof fetch), /Check your connection and try again/);
});
