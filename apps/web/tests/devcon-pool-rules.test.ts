import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { digest, settlementRuleAuthoringIssues, validateSettlementRule } from '../server/settlement-rules.mjs';
import { parseSettlementCapture } from '../server/settlement-evidence.mjs';
import { HUMAN_QUESTION_SCHEMA, validateHumanQuestion } from '../scripts/create-hybrid-reality-pilot.mjs';

const POOLS: Record<string, number> = { 'flb-2': 1793815200, 'cond-2': 1807984800 };
const rulesOf = (pool: string) => JSON.parse(readFileSync(new URL(`../../../config/markets/${pool}-rules.json`, import.meta.url), 'utf8'));
const ruleOf = (pool: string, eventId: string) => rulesOf(pool).find((r: any) => r.eventId === eventId);
const fixture = (name: string) => readFileSync(new URL(`fixtures/devcon-sources/${name}`, import.meta.url), 'utf8');
const capture = (r: any, body: string, contentType: string) => ({ requestedUrl: r.source.urls[0], finalUrl: r.source.urls[0], fetchedAt: r.timing.scheduledAt + 30,
  status: 200, contentType, complete: true, body, bytes: Buffer.byteLength(body), sha256: digest(body) });
const read = (r: any, body: string, type = 'application/json; charset=utf-8') => parseSettlementCapture(validateSettlementRule(r), capture(r, body, type), r.timing.scheduledAt + 60).value;
const reason = (fn: () => unknown) => { try { fn(); } catch (e: any) { return e.reason ?? e.message; } return 'no error'; };

test('every devcon rule validates and has no authoring issues', () => {
  for (const [pool, closesAt] of Object.entries(POOLS)) {
    const items = rulesOf(pool);
    assert.ok(items.length >= 2 && items.length <= 32, pool);
    assert.equal(new Set(items.map((item: any) => item.eventId)).size, items.length, pool);
    for (const item of items) {
      if (item.schema === HUMAN_QUESTION_SCHEMA) {
        assert.ok(validateHumanQuestion(item, closesAt, 3600).observationEndsAt > closesAt, item.eventId);
        continue;
      }
      assert.doesNotThrow(() => validateSettlementRule(item), item.eventId);
      assert.deepEqual(settlementRuleAuthoringIssues(item), [], item.eventId);
      assert.ok(item.timing.observationEndsAt > closesAt, item.eventId);
      assert.equal(item.timing.assertionPeriod, 3600, item.eventId);
      assert.equal(item.timing.challengePeriod, 3600, item.eventId);
      const stated = new RegExp(`\\s${item.decision.value.replaceAll('.', '\\.')}(?=[\\s,?])`);
      if (item.decision.type === 'number') assert.ok(stated.test(item.question)
        || (item.decision.value === '1' && item.question.includes(' at least one ')), item.eventId);
    }
  }
});

test('kraken ETHXBT candle reads the close of the committed day', () => {
  const rule = ruleOf('flb-2', 'flb-2-ethbtc'), live = fixture('kraken-ethxbt-ohlc.json');
  const shifted = live.replaceAll('1793232000', '1793664000').replaceAll('1793318400', '1793750400').replaceAll('1793404800', '1793836800');
  assert.equal(read(rule, shifted, 'application/json'), '0.02904');
  assert.ok(['VALUE_MISSING', 'EXTRACTION_AMBIGUOUS_OR_MISSING'].includes(reason(() => read(rule, live, 'application/json'))));
});

test('open-meteo daily max reads index 0 only for the committed date', () => {
  const rule = ruleOf('flb-2', 'flb-2-mumbai-heat'), body = fixture('open-meteo-mumbai-temperature-max.json');
  assert.equal(read(rule, body), '32.9');
  assert.equal(reason(() => read(rule, body.replace('"2026-11-04"', '"2026-11-05"'))), 'OBSERVATION_IDENTITY_MISMATCH');
});

test('open-meteo hourly AQI reads 17:00 IST', () => {
  const rule = ruleOf('flb-2', 'flb-2-mumbai-air'), body = fixture('open-meteo-mumbai-us-aqi.json');
  assert.equal(read(rule, body), '267');
  assert.equal(reason(() => read(rule, body.replace('"2026-11-04T17:00"', '"2026-11-05T17:00"'))), 'OBSERVATION_IDENTITY_MISMATCH');
});

test('github release count respects the window and skips drafts', () => {
  const rule = ruleOf('flb-2', 'flb-2-geth'), releases = JSON.parse(fixture('github-go-ethereum-releases.json'));
  const times = ['2026-11-01T23:59:00Z', '2026-11-03T10:00:00Z', '2026-11-05T00:01:00Z'];
  const body = (draft: boolean) => JSON.stringify(releases.map((release: any, i: number) => ({ ...release, published_at: times[i], draft: i === 1 ? draft : false })));
  assert.equal(read(rule, body(false)), '1');
  assert.equal(read(rule, body(true)), '0');
});

test('ethereum base fee rule is a block-field snapshot after its time', () => {
  const rule = ruleOf('flb-2', 'flb-2-basefee');
  assert.doesNotThrow(() => validateSettlementRule(rule));
  assert.deepEqual([rule.source.adapter, rule.source.reader.metric, rule.source.reader.field, rule.source.reader.chainId], ['evm-rpc.v1', 'block-field', 'baseFeePerGas', 1]);
  const early = structuredClone(rule);
  early.timing.scheduledAt = rule.source.reader.at - 1;
  assert.throws(() => validateSettlementRule(early), /Chain values are captured only after their observation time/);
});

test('ecb long-term rate reads the committed month', () => {
  const committed = ruleOf('cond-2', 'cond-2-oat');
  const rule = (period: string, area = 'FR') => ({ ...committed, source: { ...committed.source, reader: { ...committed.source.reader, select: { REF_AREA: area }, period } } });
  const body = fixture('ecb-irs-fr-10y.json').replaceAll('"2026-09"', '"2027-05"'), type = 'application/vnd.sdmx.data+json;version=1.0.0-wd';
  assert.equal(read(committed, body, type), '4.44');
  assert.equal(reason(() => read(rule('2027-06'), body, type)), 'VALUE_MISSING');
  assert.equal(reason(() => read(rule('2027-05', 'DE'), body, type)), 'VALUE_MISSING');
});

test('frankfurter rate counts only for the committed date', () => {
  const rule = ruleOf('cond-2', 'cond-2-eurusd'), live = fixture('frankfurter-eur-usd.json');
  assert.equal(read(rule, live.replace('"2026-10-30"', '"2027-05-03"')), '1.1172');
  assert.equal(reason(() => read(rule, live)), 'OBSERVATION_IDENTITY_MISMATCH');
});
