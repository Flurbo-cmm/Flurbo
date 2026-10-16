import assert from 'node:assert/strict';
import test from 'node:test';
import { estimatePairs, poolWeb, strongestLinks } from '../shared/pool-web.mjs';

const table = (scope: number, values: string[]) => ({ scope, values });
const quiet = () => null;

test('a fresh pool has nodes and no edges', () => {
  const web = poolWeb({ events: 4, factors: [1, 2, 4, 8].map(scope => table(scope, ['0', '0'])),
    marginals: [500, 500, 500, 500], joint: quiet });
  assert.equal(web.nodes.length, 4);
  assert.deepEqual(web.edges, []);
  assert.deepEqual(web.nodes.map(node => node.yes), [500, 500, 500, 500]);
});

test('a pair table creates one edge with the right difference', () => {
  const web = poolWeb({ events: 4, factors: [table(0b0011, ['0', '0', '0', '5'])],
    marginals: [500, 500, 500, 500], joint: () => ({ joint: 300, independent: 250 }) });
  assert.deepEqual(web.edges, [{ a: 0, b: 1, joint: 300, independent: 250, difference: 50, scope: 3 }]);
});

test('a three question table creates three edges', () => {
  const web = poolWeb({ events: 5, factors: [table(0b00111, Array(8).fill('0'))],
    marginals: Array(5).fill(500), joint: quiet });
  assert.deepEqual(web.edges.map(edge => [edge.a, edge.b]), [[0, 1], [0, 2], [1, 2]]);
});

test('edges are unique across overlapping tables', () => {
  const web = poolWeb({ events: 4, factors: [table(0b0011, Array(4).fill('0')), table(0b0111, Array(8).fill('0'))],
    marginals: Array(4).fill(500), joint: quiet });
  assert.deepEqual(web.edges.map(edge => [edge.a, edge.b]), [[0, 1], [0, 2], [1, 2]]);
  assert.equal(web.edges[0].scope, 0b0011);
});

test('strongestLinks orders by absolute difference and breaks ties by event index', () => {
  const differences: Record<string, number> = { '0-1': 10, '0-2': -40, '0-3': 40, '1-2': 90 };
  const web = poolWeb({ events: 4, factors: [table(0b0111, Array(8).fill('0')), table(0b1001, Array(4).fill('0'))],
    marginals: Array(4).fill(500),
    joint: (a: number, b: number) => ({ joint: 500 + differences[`${a}-${b}`], independent: 500 }) });
  assert.deepEqual(strongestLinks(web, 0, 3).map(link => link.other), [2, 3, 1]);
  assert.deepEqual(strongestLinks(web, 0, 1).map(link => link.other), [2]);
  assert.equal(strongestLinks(web, 0)[0].difference, -40);
  assert.deepEqual(strongestLinks(web, 3), [{ other: 0, difference: 40, edge: web.edges.find(edge => edge.b === 3) }]);
});

test('unquotable pairs are kept with null values, not dropped', () => {
  const web = poolWeb({ events: 3, factors: [table(0b011, Array(4).fill('0'))],
    marginals: [null, 500, 500], joint: quiet });
  assert.deepEqual(web.edges, [{ a: 0, b: 1, joint: null, independent: null, difference: null, scope: 3 }]);
  assert.equal(web.nodes[0].yes, null);
  assert.equal(strongestLinks(web, 0).length, 1);
  assert.equal(strongestLinks(web, 0)[0].difference, null);
});

test('rejects tables that name questions outside the pool', () => {
  assert.throws(() => poolWeb({ events: 2, factors: [table(0b100, ['0', '0'])], marginals: [500, 500], joint: quiet }),
    /outside the pool/);
});

test('estimatePairs agrees with a hand calculation', () => {
  // One pair table on questions 0 and 1 that pays only when both are Yes. Depth 1, quantity 1.
  const result = estimatePairs({ events: 2, liquidity: '1000000000000000000',
    factors: [table(3, ['0', '0', '0', '1000000000000000000'])] }, [[0, 1]]);
  const w = [1, 1, 1, Math.exp(-1)].map((x, i) => i === 3 ? 1 : Math.exp(-1));
  const total = w.reduce((s, x) => s + x, 0);
  const expectedJoint = w[3] / total, expectedA = (w[1] + w[3]) / total;
  assert.equal(result.marginals[0], Math.round(expectedA * 1000));
  assert.equal(result.pairs.get('0-1')!.joint, Math.round(expectedJoint * 1000));
  assert.equal(result.pairs.get('0-1')!.independent, Math.round(expectedA * expectedA * 1000));
});

test('estimatePairs returns no values for pools too wide to enumerate', () => {
  const result = estimatePairs({ events: 24, liquidity: '1000000000000000000', factors: [] }, [[0, 1]]);
  assert.equal(result, null);
});

test('independent pools estimate every pair as independent', () => {
  const result = estimatePairs({ events: 4, liquidity: '1000000000000000000', factors: [] }, [[0, 1], [2, 3]])!;
  for (const pair of result.pairs.values()) assert.equal(pair.difference, 0);
  assert.deepEqual(result.marginals, [500, 500, 500, 500]);
});
