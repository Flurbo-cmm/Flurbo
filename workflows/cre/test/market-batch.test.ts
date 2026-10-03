import { expect, test } from 'bun:test';
import { BATCH_SCHEMA, batchSchema, expandPool, preparePool, judgeCheck, fundingAtoms, atoms } from '../src/market-batch';
import { validateSettlementPublication } from '../../../apps/web/server/settlement-publication.mjs';
import { settlementRuleAuthoringIssues } from '../../../apps/web/server/settlement-rules.mjs';

const selection = { creator: '0xf1fea08ebba92ed342acc5639db312c3694bc391', reviewers: [1, 2, 3].map(i => ({ name: `Reviewer ${i}`, address: '0x' + String(i).repeat(40) })) };
const T = (s: string) => Date.parse(s) / 1000;
const bls = (eventId: string, series: string, value: string) => ({ eventId, question: `Will BLS ${series} for September 2026 be at least ${value}?`,
  source: { id: `bls-${series.toLowerCase()}`, publisher: 'U.S. Bureau of Labor Statistics', urls: [`https://api.bls.gov/publicAPI/v1/timeseries/data/${series}`], adapter: 'json-api.v1',
    reader: { select: '/Results/series/0/data', aggregate: 'only', field: '/value', filter: [{ path: '/year', op: 'eq', value: '2026' }, { path: '/period', op: 'eq', value: 'M09' }] } },
  observation: { series, period: '2026-09', unit: 'percent' }, decision: { type: 'number', operator: 'gte', value },
  window: { opens: '2026-10-02T12:35:00Z', closes: '2026-10-02T16:30:00Z' }, expectPending: ['EXTRACTION_AMBIGUOUS_OR_MISSING'] });
const chain = (eventId: string, at: string) => ({ eventId, question: `Will the feed report at least 1 USD at ${at}?`,
  source: { id: 'feed', publisher: 'Chainlink price feed on Monad mainnet', urls: ['https://rpc.monad.xyz/'], adapter: 'evm-rpc.v1',
    reader: { chainId: 143, at, metric: 'call', call: { to: '0xBcD78f76005B7515837af6b50c7C52BCf73822fb', data: '0x50d25bcd', returns: 'int256' }, scale: 8, finalitySeconds: 60 } },
  observation: { series: 'mon-usd', period: at, unit: 'USD' }, decision: { type: 'number', operator: 'gte', value: '0.03' },
  window: { opens: '2026-10-04T00:05:00Z', closes: '2026-10-04T03:00:00Z' } });
const batch = (): any => ({ schema: BATCH_SCHEMA, defaults: { assertionPeriod: 43200, challengePeriod: 3600, votingPeriod: 3600 }, pools: [
  { id: 'jobs-friday', title: 'Jobs Friday', label: 'Jobs Friday', closesAt: '2026-10-02T12:00:00Z', b: '100', rules: [bls('u3', 'LNS14000000', '4.2'), bls('u6', 'LNS13327709', '7.8')] },
  { id: 'crypto-weekend', title: 'Crypto weekend', label: 'Crypto weekend', closesAt: '2026-10-03T18:00:00Z', b: '250', settlement: 'finish-only', bond: '2',
    assertionPeriod: 7200, rules: [chain('mon', '2026-10-04T00:00:00Z'), { ...chain('mon2', '2026-10-04T00:00:00Z'), eventId: 'mon2' }] },
] });

test('a batch expands times, defaults and pool overrides into exact settlement rules', () => {
  const jobs = expandPool(batch(), 'jobs-friday');
  expect(jobs.closesAt).toBe(T('2026-10-02T12:00:00Z'));
  expect(jobs.liquidityAtoms).toBe('100000000');
  expect(jobs.bondAtoms).toBe('1000000');
  expect(jobs.settlement).toBe('auto');
  expect(jobs.rules[0].timing).toEqual({ scheduledAt: T('2026-10-02T12:35:00Z'), publicationCutoff: T('2026-10-02T16:30:00Z'), correctionCutoff: T('2026-10-02T16:30:00Z'),
    observationEndsAt: T('2026-10-02T16:30:00Z'), assertionPeriod: 43200, challengePeriod: 3600, votingPeriod: 3600 });
  expect(jobs.rules[0]).not.toHaveProperty('window');
  expect(jobs.rules[0]).not.toHaveProperty('expectPending');
  expect(jobs.expectPending).toEqual({ u3: ['EXTRACTION_AMBIGUOUS_OR_MISSING'], u6: ['EXTRACTION_AMBIGUOUS_OR_MISSING'] });
  const crypto = expandPool(batch(), 'crypto-weekend');
  expect([crypto.settlement, crypto.bondAtoms, crypto.assertionPeriod, crypto.liquidityAtoms]).toEqual(['finish-only', '2000000', 7200, '250000000']);
  expect((crypto.rules[0].source as any).reader.at).toBe(T('2026-10-04T00:00:00Z'));
  expect(() => expandPool(batch(), 'missing')).toThrow(/No pool/);
});

test('prepared pools pass the publication validator and authoring rules, and preparing twice gives the same hashes', () => {
  const now = T('2026-10-01T20:00:00Z');
  for (const id of ['jobs-friday', 'crypto-weekend']) {
    const pool = expandPool(batch(), id), prepared = preparePool(pool, selection, now);
    const rules = validateSettlementPublication(prepared.publication);
    for (const r of rules) expect(settlementRuleAuthoringIssues(r)).toEqual([]);
    expect(prepared.liquidityAtoms).toBe(pool.liquidityAtoms);
    expect(prepared.publication.draft.clusterId).toBe(`${id}-${pool.closesAt}`);
    expect(preparePool(pool, selection, now + 600).configHash).toBe(prepared.configHash);
  }
  // A close less than an hour after preparation cannot be deployed.
  expect(() => preparePool(expandPool(batch(), 'jobs-friday'), selection, T('2026-10-02T11:30:00Z'))).toThrow(/one hour/);
});

test('bad batches are refused before anything is prepared', () => {
  const bad = (change: (b: any) => void) => { const b = batch(); change(b); return () => batchSchema.parse(b); };
  expect(bad(b => { b.pools[1].id = 'jobs-friday'; })).toThrow(/unique/);
  expect(bad(b => { b.pools[1].label = 'Jobs Friday'; })).toThrow(/unique/);
  expect(bad(b => { b.pools[0].id = 'Jobs Friday'; })).toThrow();
  expect(bad(b => { b.pools[0].rules = [b.pools[0].rules[0]]; })).toThrow();
  expect(bad(b => { b.pools[0].rules.push(...b.pools[0].rules.slice(0, 1).map((r: any) => ({ ...r, eventId: 'x' })), ...[1, 2].map(i => ({ ...b.pools[0].rules[0], eventId: `y${i}` }))); })).toThrow();
  expect(bad(b => { b.pools[0].settlement = 'manual'; })).toThrow();
  expect(bad(b => { b.pools[0].b = '-1'; })).toThrow();
  expect(bad(b => { b.pools[0].closesAt = '2 October'; })).toThrow();
  expect(bad(b => { b.pools[0].rules[0].window.extra = 1; })).toThrow();
});

test('rule check verdicts: ok, an expected pre-release reason, or blocked', () => {
  expect(judgeCheck({ status: 'ok', sources: [] })).toBe('ok');
  const pending = { status: 'source-error', sources: [{ result: 'source-error', reason: 'SOURCE_FETCH_FAILED' }] };
  expect(judgeCheck(pending, ['SOURCE_FETCH_FAILED'])).toBe('expected-pending');
  expect(judgeCheck(pending, ['SOURCE_EMPTY'])).toBe('blocked');
  expect(judgeCheck(pending)).toBe('blocked');
  expect(judgeCheck({ status: 'already-public', sources: [] }, ['SOURCE_FETCH_FAILED'])).toBe('blocked');
  expect(judgeCheck({ status: 'invalid' })).toBe('blocked');
});

test('funding is b times questions times ln 2, rounded up, in test AUSD atoms', () => {
  expect(atoms('250')).toBe('250000000');
  expect(atoms('0.5')).toBe('500000');
  expect(fundingAtoms('250000000', 4)).toBe('693147181');
  expect(fundingAtoms('100000000', 4)).toBe('277258873');
  expect(fundingAtoms('250000000', 3)).toBe('519860386');
});
