import { expect, test } from 'bun:test';
import { prepareWave2F2, prepareWave2F3, F2_TIMES, F3_TIMES } from '../src/wave2';
import { validateSettlementPublication } from '../../../apps/web/server/settlement-publication.mjs';

const selection = { creator: '0xf1fea08ebba92ed342acc5639db312c3694bc391', reviewers: [1, 2, 3].map(i => ({ name: `Reviewer ${i}`, address: '0x' + String(i).repeat(40) })) };
const at = (d: number, h: number, m: number) => Date.UTC(2026, 9, d) / 1000 + h * 3600 + m * 60;
const testNow = at(1, 12, 0); // 1 Oct 2026 12:00

test('F2 refuses to prepare without thresholds', () => { expect(() => prepareWave2F2(selection, testNow, {})).toThrow(); });

test('F2 rule hashes stable, passes validator, chain 143, timings after close', () => {
  const prepared = prepareWave2F2(selection, testNow, { f2: { mon: 0.034, btc: 85000, eth: 2700, sol: 120 } });
  const rules = validateSettlementPublication(prepared.publication);
  
  expect(prepared.liquidityAtoms).toBe('100000000'); // b = 100
  expect(rules.length).toBe(4);
  expect(prepared.publication.challengePeriod).toBe(43200);
  expect(prepared.publication.votingPeriod).toBe(43200);
  expect(prepared.publication.assertionPeriod).toBe(43200);
  
  for (const r of rules) {
    const reader = (r as any).source.reader;
    expect(reader.chainId).toBe(143); // Monad Mainnet
    expect(r.timing.scheduledAt).toBeGreaterThan(F2_TIMES.closesAt);
    expect(r.timing.challengePeriod).toBe(43200);
    expect(r.timing.votingPeriod).toBe(43200);
  }

  // Check question text snippet
  expect(rules[0].question).toContain('on Monad at');
});

test('F3 rule hashes stable, passes validator, 6258 for B4, no FLÁVIO accent, Boulos removed', () => {
  const prepared = prepareWave2F3(selection, testNow);
  const rules = validateSettlementPublication(prepared.publication);
  
  expect(prepared.liquidityAtoms).toBe('250000000'); // b = 250
  expect(rules.length).toBe(4);
  expect(prepared.publication.challengePeriod).toBe(43200);
  expect(prepared.publication.votingPeriod).toBe(43200);
  expect(prepared.publication.assertionPeriod).toBe(172800);

  // Check texts and specific conditions
  const b1 = rules[0] as any;
  const b2 = rules[1] as any;
  const b3 = rules[2] as any;
  const b4 = rules[3] as any;

  expect(b1.question).toBe('Will Luiz Inácio Lula da Silva finish first in the first round of the 2026 Brazil presidential election?');
  expect(b2.question).toBe('Will the 2026 Brazil presidential election require a runoff?');
  expect(b3.question).toBe('Will Flavio Bolsonaro reach the runoff in the 2026 Brazil presidential election?'); // No accent
  expect(b4.question).toBe('Will Luiz Inácio Lula da Silva be elected in the 25 October runoff in the 2026 Brazil presidential election? If no runoff is held, this question resolves No by operator assertion from the first-round result.');

  expect(b4.source.urls[0]).toContain('6258');
  expect(b1.source.urls[0]).toContain('6257');
  
  expect(b1.timing.scheduledAt).toBeGreaterThan(F3_TIMES.closesAt);
  expect(b4.timing.scheduledAt).toBeGreaterThan(F3_TIMES.closesAt);
});
