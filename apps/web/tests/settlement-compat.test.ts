import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GENERAL_ADAPTERS, SETTLEMENT_ADAPTERS, settlementRuleHash, validateSettlementRule } from '../server/settlement-rules.mjs';
import { hybridSettlementCatalog } from '../server/hybrid-settlement-worker.mjs';

const load = (file: string) => JSON.parse(readFileSync(new URL(`../../../config/${file}`, import.meta.url), 'utf8'));
function rulesIn(value: any, path = '', found: Record<string, any> = {}) {
  if (value && typeof value === 'object') {
    if (value.schema === 'flurbo.settlement-rule.v1') found[path] = value;
    for (const key of Object.keys(value)) rulesIn(value[key], `${path}/${key}`, found);
  }
  return found;
}

const GOLDEN: Record<string, string> = {
  'hybrid-markets.json /pools/0/prepared/draft/events/0/rule': '294ee813e724176a0a6071e6307c8f6b9e4a5d41667930632a11e89a34f60ef1',
  'hybrid-markets.json /pools/0/prepared/draft/events/1/rule': '8fac80b7adedeed41878579e5d73e68c86d227c6dbd24588f951951cafca0ed7',
  'hybrid-markets.json /pools/1/prepared/draft/events/0/rule': '0880716327216685b7766bef3a70210c498917ddb1aef51f8e7fb009f2da0867',
  'hybrid-markets.json /pools/1/prepared/draft/events/1/rule': '5133df4db0c3a312a730947022a1649b5de27c6e6be9dfc5096945142f1f9ea4',
  'hybrid-markets.json /pools/2/prepared/draft/events/0/rule': 'd4024b64bb3da631b1aea7bd313b147fccd9d85d443b18cbbe632c4ed6893548',
  'hybrid-markets.json /pools/2/prepared/draft/events/1/rule': '22a72ca5f4a4050d8e6f324564d18a4e94bebd97741abcf29157f7415aaae114',
};

const jsonRule = (reader: any) => ({ schema: 'flurbo.settlement-rule.v1', eventId: 'event-1', question: 'Will the value be at least the threshold?',
  source: { id: 'source-1', publisher: 'Example publisher', urls: ['https://data.example.org/value'], adapter: 'json-api.v1', reader },
  observation: { series: 'example-series', period: '2026-09', unit: 'units' }, decision: { type: 'number', operator: 'gte', value: '4' },
  timing: { scheduledAt: 1_791_000_000, publicationCutoff: 1_791_003_600, correctionCutoff: 1_791_003_600, observationEndsAt: 1_791_003_600,
    assertionPeriod: 3600, challengePeriod: 3600, votingPeriod: 3600 },
  vintage: 'first-observed-snapshot', missingPolicy: 'resolver-timeout-void' });

test('deployed rules keep their hashes', () => {
  const actual: Record<string, string> = {};
  for (const [path, rule] of Object.entries(rulesIn(load('hybrid-markets.json')))) actual[`hybrid-markets.json ${path}`] = settlementRuleHash(rule);
  assert.deepEqual(actual, GOLDEN);
});

test('existing readers stay first and in order', () => {
  assert.deepEqual(SETTLEMENT_ADAPTERS.slice(0, 8), ['json-record.v1', 'bls-employment-html.v1', 'fomc-statement-html.v1', 'usgs-earthquake-count.v1',
    'json-api.v1', 'stat-table.v1', 'html-text.v1', 'evm-rpc.v1']);
  assert.deepEqual(GENERAL_ADAPTERS.slice(0, 4), ['json-api.v1', 'stat-table.v1', 'html-text.v1', 'evm-rpc.v1']);
});

test('frozen readers refuse settings that only new readers accept', () => {
  const base = { select: '/a', aggregate: 'value' };
  assert.doesNotThrow(() => validateSettlementRule(jsonRule(base)));
  assert.throws(() => validateSettlementRule(jsonRule({ ...base, request: { method: 'POST', body: '{}' } })));
  assert.throws(() => validateSettlementRule(jsonRule({ ...base, derive: { op: 'difference', select: '/b', aggregate: 'value' } })));
  assert.throws(() => validateSettlementRule(jsonRule({ select: '/items', aggregate: 'count', filter: [{ path: '/title', op: 'contains', value: 'rate' }] })));
  const page = jsonRule({ anchors: ['Monthly Report'], pattern: 'index (rose|fell) to', pages: { first: 1, last: 1 } });
  page.source.adapter = 'html-text.v1';
  assert.throws(() => validateSettlementRule({ ...page, decision: { type: 'category', operator: 'eq', value: 'rose' } }));
});

test('the deployed hybrid catalog still verifies', () => {
  assert.doesNotThrow(() => hybridSettlementCatalog(load('hybrid-markets.json')));
});
