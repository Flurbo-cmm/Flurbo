import assert from 'node:assert/strict';
import { test } from 'node:test';
import { walletRejected } from '../src/wallet-errors.ts';

test('a plain EIP-1193 rejection is recognised', () => {
  assert.equal(walletRejected(Object.assign(Error('User rejected the request.'), { code: 4001 })), true);
  assert.equal(walletRejected({ code: '4001', message: 'x' }), true);
});

test('rejections wrapped by the wallet or a library are recognised', () => {
  assert.equal(walletRejected({ code: -32603, message: 'Internal JSON-RPC error.',
    data: { originalError: { code: 4001, message: 'User denied transaction signature.' } } }), true);
  assert.equal(walletRejected({ code: -32603, data: { code: 4001 } }), true);
  assert.equal(walletRejected({ error: { code: 4001 } }), true);
  assert.equal(walletRejected(Object.assign(Error('wrapped'), { cause: { code: 4001 } })), true);
  assert.equal(walletRejected({ code: 'ACTION_REJECTED' }), true);
});

test('rejection messages without a code are recognised', () => {
  assert.equal(walletRejected(Error('MetaMask Tx Signature: User denied transaction signature.')), true);
  assert.equal(walletRejected({ message: 'User rejected the request.' }), true);
  assert.equal(walletRejected({ code: -32603, message: 'Request cancelled by user' }), true);
});

test('other wallet failures are not treated as a cancel', () => {
  assert.equal(walletRejected(null), false);
  assert.equal(walletRejected(undefined), false);
  assert.equal(walletRejected(Error('insufficient funds for gas')), false);
  assert.equal(walletRejected({ code: -32603, message: 'Internal JSON-RPC error.', data: { code: -32000 } }), false);
  assert.equal(walletRejected({ code: 4100, message: 'Unauthorized' }), false);
});

test('a self-referencing error does not loop', () => {
  const error: Record<string, unknown> = { code: -32603 };
  error.cause = error; error.data = error;
  assert.equal(walletRejected(error), false);
});
