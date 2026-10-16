import assert from 'node:assert/strict';
import test from 'node:test';
import { portfolioGatePending } from '../src/portfolio-gate.ts';

test('saved holdings never block the page', () => {
  assert.equal(portfolioGatePending({ busy: true, rowCount: 3, saved: false, anyDone: false }), false);
  assert.equal(portfolioGatePending({ busy: true, rowCount: 0, saved: true, anyDone: false }), false);
});

test('a first ever load with nothing saved blocks until a read finishes', () => {
  assert.equal(portfolioGatePending({ busy: true, rowCount: 0, saved: false, anyDone: false }), true);
  assert.equal(portfolioGatePending({ busy: true, rowCount: 0, saved: false, anyDone: true }), false);
});

test('an error or a finished load clears the gate', () => {
  assert.equal(portfolioGatePending({ busy: false, rowCount: 0, saved: false, anyDone: false }), false);
  assert.equal(portfolioGatePending({ busy: true, rowCount: 0, saved: false, anyDone: true }), false);
});
