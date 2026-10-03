import { expect, test } from 'bun:test';
import { preparePreTest, PRE_TEST_TIMES } from '../src/pre-test-v1';
import { validateSettlementPublication } from '../../../apps/web/server/settlement-publication.mjs';

const selection = { creator: '0xf1fea08ebba92ed342acc5639db312c3694bc391', reviewers: [1, 2, 3].map(i => ({ name: `Reviewer ${i}`, address: '0x' + String(i).repeat(40) })) };
const at = (h: number, m: number) => Date.UTC(2026, 8, 30, h, m) / 1000;

test('pre-test-v1 uses four sources, b = 25, and settles before 17:00 IST', () => {
  const prepared = preparePreTest(selection, at(5, 30), undefined, { reproduce: true });
  const rules = validateSettlementPublication(prepared.publication);
  expect(prepared.liquidityAtoms).toBe('25000000');
  expect(rules.map((r: any) => r.source.adapter)).toEqual(['json-api.v1', 'evm-rpc.v1', 'json-api.v1', 'json-api.v1']);
  expect(new Set(rules.map((r: any) => new URL(r.source.urls[0]).hostname)).size).toBe(4);
  const close = prepared.publication.draft.closesAt;
  expect(close).toBe(at(7, 5));
  for (const r of rules) expect(r.timing.scheduledAt).toBeGreaterThan(close);
  const finals = rules.map((r: any) => r.timing.observationEndsAt + 3600);
  expect(new Set(finals).size).toBe(4);
  expect(Math.max(...finals)).toBeLessThanOrEqual(PRE_TEST_TIMES.deadline - 600);
});

test('the template can no longer author a collection: catalogue captures open too soon after the counted hour', () => {
  expect(() => preparePreTest(selection, at(5, 30))).toThrow(/usgs-m25-hour: The capture window opens 30 minutes after .* at least 3 hours/);
});

test('preparing too late, or with a close after the counted hour could start, is refused', () => {
  expect(() => preparePreTest(selection, at(7, 0))).toThrow(/Too late/);
  expect(() => preparePreTest(selection, at(6, 0), at(6, 55))).toThrow(/more than an hour/);
  expect(() => preparePreTest(selection, at(5, 0), at(8, 45))).toThrow(/Too late/);
});
