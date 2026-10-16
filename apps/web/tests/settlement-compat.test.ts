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
  'hybrid-markets.json /pools/3/prepared/draft/events/0/rule': 'e969425f8528a6366906446aaa72ec73957e9567db6613ad6c2e1cbeeaf6ce28',
  'hybrid-markets.json /pools/3/prepared/draft/events/1/rule': '33139e904cde6ac400f28147f15158c700b1053839ef2e86559afd01718eec2f',
  'hybrid-markets.json /pools/3/prepared/draft/events/2/rule': 'd5bf3458868b35784197abfdcf771f16619c9ffcaa91cfdcacb396958fccf602',
  'hybrid-markets.json /pools/3/prepared/draft/events/3/rule': '367bdb0db4bea31df029ad91c0fff3fc775d69cb065a33619baf735996b60bd9',
  'hybrid-markets.json /pools/3/prepared/draft/events/4/rule': '0b7d64dbf522b1a6bf7e3e6dd304bd770258d72cc07bd31d431a88a9eb58b789',
  'hybrid-markets.json /pools/3/prepared/draft/events/5/rule': '26e52b2993911e2e284833540766a94aadfa38a212b583e6c96aa5384d790a4b',
  'hybrid-markets.json /pools/3/prepared/draft/events/6/rule': '9ba2062c3cb506f61949c5584175aba54c27f442e21f456a3b63484bd6c42a74',
  'hybrid-markets.json /pools/3/prepared/draft/events/7/rule': 'dcd69ddaf8ffa6fd2b12f1e0f89e6c3263fdfac4aa236bea0719d82fdadbcf64',
  'hybrid-markets.json /pools/3/prepared/draft/events/8/rule': 'b03b8d018a419000064be891b2c6e8add92abc9172ba347eda480df0177da543',
  'hybrid-markets.json /pools/3/prepared/draft/events/9/rule': '8bdf392b95c5cd53895fdd397a38eb8a758e33e384a3fda69b3ba70554e8e404',
  'hybrid-markets.json /pools/3/prepared/draft/events/10/rule': 'e2442f408f2a402138a31decdac1e96115fa051ca5aea6588e96473dad242e75',
  'hybrid-markets.json /pools/3/prepared/draft/events/11/rule': '53541b90f81bdda66c9355ab4bc042334c1dd5677d53e87f644d1002acd31ffc',
  'hybrid-markets.json /pools/3/prepared/draft/events/12/rule': '37d2bec85fed8775eb780899ae59e5accb29f2cde00c890218bd02c011cac4e9',
  'hybrid-markets.json /pools/3/prepared/draft/events/13/rule': '97e35550beb1a833f26b1c57ae6f516eb3b3d46ca20c6fd4b7bee623f0747295',
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
