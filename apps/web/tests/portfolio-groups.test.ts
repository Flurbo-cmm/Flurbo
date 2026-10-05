import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeClaim } from '../shared/claims.mjs';
import { firstEvent, hybridClaimHref, hybridNamespace, hybridPortfolioGroups, isHybridGroup, isHybridNamespace } from '../src/portfolio-groups.ts';

test('hybrid markets become one portfolio group per pool', () => {
  const mixed = '0x' + 'AB'.repeat(20), other = '0x' + 'cd'.repeat(20);
  const groups = hybridPortfolioGroups([
    { pool: mixed, poolTitle: 'First pool', closesAt: 10 }, { pool: mixed.toLowerCase(), poolTitle: 'First pool', closesAt: 10 },
    { pool: other, poolTitle: 'Second pool', closesAt: 20 }]);
  assert.deepEqual(groups, [
    { kind: 'hybrid', namespace: 'hybrid-0x' + 'ab'.repeat(20), label: 'First pool', pool: '0x' + 'ab'.repeat(20), closesAt: 10 },
    { kind: 'hybrid', namespace: 'hybrid-0x' + 'cd'.repeat(20), label: 'Second pool', pool: other, closesAt: 20 }]);
});

test('hybrid namespaces are validated', () => {
  const hex = 'ab'.repeat(20);
  assert.equal(isHybridNamespace('hybrid-0x' + hex), true);
  for (const bad of ['hybrid-0x' + hex.toUpperCase(), 'practice-0x' + hex, 'pilot', 'hybrid-0x123']) assert.equal(isHybridNamespace(bad), false);
  assert.equal(hybridNamespace('0x' + hex.toUpperCase()), 'hybrid-0x' + hex);
  assert.throws(() => hybridNamespace('nope'), /Invalid hybrid pool/);
  assert.equal(isHybridGroup({ namespace: 'pilot', label: '', pool: '0x' + hex, closesAt: 1 }), false);
});

test('claim links preselect the purchased claim', () => {
  const p = '0x' + '44'.repeat(20), base = `/markets/hybrid/${p}`;
  assert.equal(hybridClaimHref(p, 1, '2'), `${base}/0?answer=yes`);
  assert.equal(hybridClaimHref(p, 2, '1'), `${base}/1?answer=no`);
  assert.equal(hybridClaimHref(p, 3, '8'), `${base}/0?answer=yes&other=1&otherAnswer=yes&rule=AND`);
  assert.equal(hybridClaimHref(p, 3, '14'), `${base}/0?answer=yes&other=1&otherAnswer=yes&rule=OR`);
  assert.equal(hybridClaimHref(p, 3, '6'), `${base}/0?answer=yes&other=1&otherAnswer=yes&rule=EXACTLY_ONE`);
  assert.equal(hybridClaimHref(p, 7, '128'), `${base}/0?answer=yes&other=1&otherAnswer=yes&third=2&thirdAnswer=yes&rule=AND`);
  assert.equal(decodeClaim(7, '232', 32)?.rule, 'AT_LEAST_TWO');
  assert.equal(hybridClaimHref(p, 7, '232'), `${base}/0`);
  assert.equal(hybridClaimHref(p, 6, '8'), `${base}/1?answer=yes&other=2&otherAnswer=yes&rule=AND`);
});

test('firstEvent handles the highest question', () => {
  assert.equal(firstEvent(2 ** 31), 31);
  assert.equal(firstEvent(6), 1);
});
