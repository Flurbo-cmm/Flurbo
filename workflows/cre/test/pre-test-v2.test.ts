import { expect, test } from 'bun:test';
import { preparePreTestV2, PRE_TEST_V2_TIMES } from '../src/pre-test-v2';
import { validateSettlementPublication } from '../../../apps/web/server/settlement-publication.mjs';

const selection = { creator: '0xf1fea08ebba92ed342acc5639db312c3694bc391', reviewers: [1, 2, 3].map(i => ({ name: `Reviewer ${i}`, address: '0x' + String(i).repeat(40) })) };
const at = (h: number, m: number) => Date.UTC(2026, 9, 1, h, m) / 1000;

test('pre-test-v2 has two questions under the current authoring rules, b = 25, settled before 17:00 IST', () => {
  const prepared = preparePreTestV2(selection, at(5, 30));
  const rules = validateSettlementPublication(prepared.publication);
  expect(prepared.liquidityAtoms).toBe('25000000');
  expect(rules.map((r: any) => r.source.adapter)).toEqual(['json-api.v1', 'evm-rpc.v1']);
  const close = prepared.publication.draft.closesAt;
  expect(close).toBe(at(7, 5));
  for (const r of rules) expect(r.timing.scheduledAt).toBeGreaterThan(close);
  expect((rules[1] as any).source.reader.at).toBeGreaterThan(close);
  const finals = rules.map((r: any) => r.timing.observationEndsAt + 3600);
  expect(Math.max(...finals)).toBeLessThanOrEqual(PRE_TEST_V2_TIMES.deadline - 600);
});

test('preparing too late or too close to the deploy is refused', () => {
  expect(() => preparePreTestV2(selection, at(7, 0))).toThrow(/Too late/);
  expect(() => preparePreTestV2(selection, at(6, 0), at(6, 55))).toThrow(/more than an hour/);
});
