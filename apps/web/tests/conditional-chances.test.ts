import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { certifiedConditional, certifiedScenario } from '../server/pair-math.mjs';

const pairs = JSON.parse(await readFile(new URL('./fixtures/pair-analytics.json', import.meta.url), 'utf8'));
const wide = JSON.parse(await readFile(new URL('./fixtures/wide-analytics.json', import.meta.url), 'utf8'));
type Leg = { event: number; yes: boolean };

function enumerate(state: any, condition: Leg[], target: Leg[]) {
  const d = Number(state.liquidity);
  const scores = Array.from({ length: 2 ** state.events }, (_, x) => state.factors.reduce((sum: number, f: any) => {
    let local = 0, bit = 0;
    for (let e = 0; e < state.events; e++) if (f.scope & (1 << e)) { if (x & (1 << e)) local |= 1 << bit; bit++; }
    return sum + Number(f.values[local]) / d;
  }, 0));
  const top = Math.max(...scores), weights = scores.map(s => Math.exp(s - top));
  const holds = (legs: Leg[], x: number) => legs.every(l => Boolean(x & (1 << l.event)) === l.yes);
  const sum = (test: (x: number) => boolean) => weights.reduce((a, w, x) => a + (test(x) ? w : 0), 0);
  const total = sum(() => true), c = sum(x => holds(condition, x));
  return { condition: c / total, target: sum(x => holds(target, x)) / total,
    given: sum(x => holds(condition, x) && holds(target, x)) / c,
    givenNot: sum(x => !holds(condition, x) && holds(target, x)) / (total - c) };
}

function compare(state: any, condition: Leg[], target: Leg[], label: string) {
  const certified = certifiedConditional(state, condition, target), exact = enumerate(state, condition, target);
  let shown = 0;
  for (const key of ['condition', 'target', 'given', 'givenNot'] as const) {
    const value = certified.values[key];
    if (value === null) {
      assert.ok(['rounding_uncertain', 'rare_condition'].includes(certified.reasons[key]), `${label} ${key}`);
      if (certified.reasons[key] === 'rare_condition')
        assert.ok(key === 'given' ? exact.condition < 1e-9 : 1 - exact.condition < 1e-9, `${label} ${key} rare`);
      continue;
    }
    shown++;
    assert.ok(Math.abs(value - exact[key] * 1000) <= 0.5 + 1e-6, `${label} ${key}: ${value} vs ${exact[key]}`);
  }
  return shown;
}

test('certifiedConditional equals enumeration on 2 to 4 question pools', () => {
  let shown = 0, checked = 0;
  for (const row of pairs) {
    const n = row.state.events;
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
      if (a === b) continue;
      for (const cy of [true, false]) for (const ty of [true, false]) {
        shown += compare(row.state, [{ event: a, yes: cy }], [{ event: b, yes: ty }], `${row.name} ${a}${cy} ${b}${ty}`);
        checked += 4;
      }
    }
    if (n >= 3) {
      shown += compare(row.state, [{ event: 0, yes: true }], [{ event: 1, yes: true }, { event: 2, yes: false }], `${row.name} two-leg target`);
      shown += compare(row.state, [{ event: 1, yes: false }, { event: 2, yes: true }], [{ event: 0, yes: true }], `${row.name} two-leg condition`);
      checked += 8;
    }
  }
  assert.ok(shown > checked * 0.9, `${shown} of ${checked} values shown`);
});

test('certifiedConditional equals certifiedScenario for single legs on a 16-question pool', () => {
  for (const row of wide.filter((r: any) => r.state.events === 16)) {
    for (const [a, b] of [[0, 1], [3, 9], [15, 2]]) for (const yes of [true, false]) {
      const result = certifiedConditional(row.state, [{ event: a, yes }], [{ event: b, yes: true }]);
      const assumed = certifiedScenario(row.state, [{ event: a, yes }]);
      const negated = certifiedScenario(row.state, [{ event: a, yes: !yes }]);
      assert.equal(result.values.condition, assumed.values.given, `${row.name} condition`);
      assert.equal(result.values.target, assumed.questions[b].yes, `${row.name} target`);
      assert.equal(result.values.given, assumed.questions[b].givenYes, `${row.name} given`);
      assert.equal(result.values.givenNot, negated.questions[b].givenYes, `${row.name} given not`);
    }
  }
});

test('certifiedConditional refuses overlapping, empty or oversized legs', () => {
  const state = pairs.find((r: any) => r.state.events === 4).state;
  for (const [condition, target] of [
    [[{ event: 0, yes: true }], [{ event: 0, yes: false }]],
    [[], [{ event: 1, yes: true }]],
    [[{ event: 0, yes: true }], []],
    [[{ event: 0, yes: true }, { event: 1, yes: true }], [{ event: 2, yes: true }, { event: 3, yes: true }]],
    [[{ event: 0, yes: true }, { event: 1, yes: true }, { event: 2, yes: true }], [{ event: 3, yes: true }]],
    [[{ event: 4, yes: true }], [{ event: 1, yes: true }]],
    [[{ event: 0, yes: 1 }], [{ event: 1, yes: true }]],
  ] as any[]) assert.throws(() => certifiedConditional(state, condition, target), /Invalid conditional/);
});
