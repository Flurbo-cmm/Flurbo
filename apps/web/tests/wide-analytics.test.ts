import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { runPairModel } from '../server/pair-analytics.mjs';
import { certifiedCells, certifiedClaim, certifiedPair, certifiedScenario, pairInput, scenarioInput } from '../server/pair-math.mjs';
import { rustExample } from './rust-example.ts';

const wide = JSON.parse(await readFile(new URL('./fixtures/wide-analytics.json', import.meta.url), 'utf8'));
const pairFixtures = JSON.parse(await readFile(new URL('./fixtures/pair-analytics.json', import.meta.url), 'utf8'));
const model = (input: string) => runPairModel(input, { file: rustExample('pair_analytics') });
const rows = (...kinds: string[]) => wide.filter((row: any) => kinds.includes(row.kind));
const given = (legs: any[]) => legs.map(({ event, yes }: any) => ({ event, yes }));

function checkRow(row: any) {
  const state = row.state;
  assert.deepEqual(certifiedPair(state).values, row.pair.displayed, `${row.name} pair`);
  for (const extra of row.morePairs ?? [])
    assert.deepEqual(certifiedPair({ ...state, a: extra.a, b: extra.b }).values, extra.displayed, `${row.name} pair ${extra.a}-${extra.b}`);
  for (const [i, scenario] of row.scenarios.entries()) {
    const result = certifiedScenario(state, given(scenario.given));
    assert.equal(result.values.given, scenario.displayed.given, `${row.name} scenario ${i} chance`);
    assert.deepEqual(result.questions.map((q: any) => ({ event: q.event, yes: q.yes, givenYes: q.givenYes })),
      scenario.displayed.questions, `${row.name} scenario ${i}`);
    const assumed = result.questions.filter((q: any) => q.assumed).map((q: any) => q.event).sort((a: number, b: number) => a - b);
    assert.deepEqual(assumed, scenario.given.map((leg: any) => leg.event).sort((a: number, b: number) => a - b));
  }
  for (const claim of row.claims) {
    assert.deepEqual(certifiedClaim(state, claim.scope, claim.mask).values, claim.displayed, `${row.name} claim ${claim.rule}`);
    assert.deepEqual(certifiedCells(state, claim.scope).map((cell: any) => cell.chance), claim.cells, `${row.name} cells ${claim.rule}`);
  }
}

test('certified pair, claim and scenario values match 90-digit fixtures for pools of 5 to 16 questions', () => {
  const checked = rows('enumerated', 'ls');
  assert.equal(checked.length, 28);
  for (const row of checked) checkRow(row);
  const rare = wide.find((row: any) => row.name === 'rare-assumption');
  assert.ok(rare.scenarios.some((s: any) => s.displayed.questions.every((q: any) => q.givenYes === null)), 'a rare assumption has no conditional values');
});

test('a 32-question pool of independent blocks matches the closed form', () => {
  const blocks = rows('blocks');
  assert.equal(blocks.length, 6);
  for (const row of blocks) { assert.equal(row.state.events, 32); checkRow(row); }
});

test('the 2 to 4 question pair fixtures are unchanged by elimination', () => {
  for (const row of pairFixtures) assert.deepEqual(certifiedPair(row.state).values, row.displayed, row.name);
});

test('the widened Rust model agrees with the wide fixtures for pairs and scenarios', async () => {
  for (const row of wide) {
    const pair = await model(pairInput(row.state));
    for (const [key, expected] of Object.entries(row.pair.precise))
      assert.ok(Math.abs(pair[key] - Number(expected)) < 2e-13, `${row.name} pair ${key}`);
    for (const [i, scenario] of row.scenarios.entries()) {
      const result = await model(scenarioInput(row.state, given(scenario.given)));
      assert.ok(Math.abs(result.given - Number(scenario.precise.given)) < 2e-13, `${row.name} scenario ${i} given`);
      assert.equal(result.yes.length, row.state.events);
      for (let e = 0; e < row.state.events; e += 1) {
        assert.ok(Math.abs(result.yes[e] - Number(scenario.precise.yes[e])) < 2e-13, `${row.name} scenario ${i} yes ${e}`);
        if (scenario.displayed.questions[e].givenYes !== null)
          assert.ok(Math.abs(result.givenYes[e] - Number(scenario.precise.givenYes[e])) < 2e-13, `${row.name} scenario ${i} givenYes ${e}`);
      }
      for (const leg of scenario.given) assert.equal(result.givenYes[leg.event], leg.yes ? 1 : 0);
    }
  }
});

test('graph width, factor count, atoms, domain and event count still fail closed on wide pools', () => {
  const base = wide.find((row: any) => row.name === 'enumerated-5-0').state;
  const events6 = { events: 6, a: 0, b: 2, liquidity: '10000000', order: [0, 1, 2, 3, 4, 5] };
  const pair = (scope: number) => ({ scope, values: ['0', '0', '0', '1'] });
  assert.throws(() => certifiedPair({ ...events6, factors: [3, 5, 9].map(pair) }), /Unsupported graph width/);
  assert.throws(() => certifiedPair({ ...events6, factors: Array.from({ length: 65 }, () => ({ scope: 1, values: ['0', '0'] })) }), /Invalid factors/);
  assert.throws(() => certifiedScenario({ events: 33, liquidity: '10000000', order: Array.from({ length: 33 }, (_, i) => i), factors: [] }, [{ event: 0, yes: true }]));
  assert.throws(() => certifiedPair({ events: 1, a: 0, b: 0, liquidity: '10000000', order: [0], factors: [] }));
  assert.throws(() => certifiedPair({ ...base, factors: [{ scope: 1, values: ['0', String(2n ** 128n)] }] }));
  assert.throws(() => certifiedPair({ ...base, factors: [{ scope: 1, values: ['0', '1000000001'] }] }), /numerical domain/);
  assert.throws(() => certifiedScenario({ ...base, order: [0, 1, 2, 3, 3] }, [{ event: 0, yes: true }]));
  for (const bad of [[], [{ event: 9, yes: true }], [{ event: 0, yes: true }, { event: 0, yes: false }],
    [0, 1, 2, 3].map(event => ({ event, yes: true })), [{ event: 0, yes: 'yes' }], [{ event: 1.5, yes: true }]])
    assert.throws(() => certifiedScenario(base, bad as any), /Invalid assumptions/);
  assert.throws(() => scenarioInput(base, [{ event: 0, yes: true }, { event: 0, yes: true }]));
});

test('a 32-question scenario with three assumptions is certified in under two seconds', () => {
  const row = rows('blocks').at(-1);
  const legs = given(row.scenarios[2].given);
  assert.equal(legs.length, 3);
  const started = performance.now();
  const result = certifiedScenario(row.state, legs);
  const elapsed = performance.now() - started;
  assert.equal(result.questions.length, 32);
  assert.ok(elapsed < 2000, `took ${Math.round(elapsed)} ms`);
});

test('outcome cells of a claim add up to one and the paying cells add up to the claim chance, within rounding', () => {
  for (const row of [...rows('enumerated'), ...rows('blocks')]) for (const claim of row.claims) {
    const cells = certifiedCells(row.state, claim.scope);
    assert.equal(cells.length, 2 ** claim.legs.length);
    assert.ok(cells.every((cell: any, state: number) => cell.state === state && cell.chance !== null));
    const total = cells.reduce((sum: number, cell: any) => sum + cell.chance, 0);
    assert.ok(Math.abs(total - 1000) <= cells.length / 2, `${row.name} total ${total}`);
    const paying = cells.filter((cell: any) => (BigInt(claim.mask) >> BigInt(cell.state)) & 1n).reduce((sum: number, cell: any) => sum + cell.chance, 0);
    assert.ok(Math.abs(paying - claim.displayed.market) <= cells.length / 2, `${row.name} paying ${paying} vs ${claim.displayed.market}`);
  }
});
