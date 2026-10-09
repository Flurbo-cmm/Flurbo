import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canDismiss, sheetPhase } from '../src/sheet-state.ts';

test('sheet phase follows the flow state with pending first', () => {
  const base = { review: null, pending: null, completed: false, walletRequest: false };
  assert.equal(sheetPhase(base), 'closed');
  assert.equal(sheetPhase({ ...base, completed: 'Purchase complete' }), 'done');
  assert.equal(sheetPhase({ ...base, review: {}, completed: true }), 'review');
  assert.equal(sheetPhase({ ...base, review: {}, walletRequest: true }), 'wallet');
  assert.equal(sheetPhase({ ...base, review: {}, walletRequest: true, pending: { hash: '0x1' } }), 'pending');
  assert.equal(sheetPhase({ ...base, pending: {} }), 'pending');
  assert.equal(sheetPhase({ ...base, completed: '' }), 'closed');
});

test('dismissal is blocked while the wallet is asked and before a hash exists', () => {
  assert.equal(canDismiss('wallet', false), false);
  assert.equal(canDismiss('wallet', true), false);
  assert.equal(canDismiss('pending', false), false);
  assert.equal(canDismiss('pending', true), true);
  for (const phase of ['review', 'done', 'failed', 'closed'] as const) assert.equal(canDismiss(phase, false), true, phase);
});
