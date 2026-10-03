import { z } from 'zod';
import { preparePilot, disputePolicy, VOID_POLICY } from './pilot-config';
import { settlementEvent } from '../../../apps/web/server/settlement-publication.mjs';

// A market batch file describes any number of pools in one place: their questions, sources, capture windows, depth
// and how the settlement bot treats them. Times may be written as UTC ISO strings. Each pool is prepared into
// target/deployments/<id>-prepared.json, the same prepared format every deploy script and verifier already uses.
// This module has no file or network access; scripts/batch.ts does the reading, checking and writing.
export const BATCH_SCHEMA = 'flurbo.market-batch.v1';
export const SETTLEMENT_MODES = ['auto', 'finish-only', 'off'] as const;
const ID = /^[a-z0-9][a-z0-9-]{2,40}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ()-]{2,59}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?Z$/;
const time = z.union([z.number().int().positive(), z.string().regex(ISO)]);
const ausd = z.string().regex(/^(?:0|[1-9]\d{0,6})(?:\.\d{1,6})?$/);
const period = (max: number) => z.number().int().min(3600).max(max);
const policy = { bond: ausd.optional(), assertionPeriod: period(30 * 86400).optional(), challengePeriod: period(7 * 86400).optional(),
  votingPeriod: period(7 * 86400).optional(), settlement: z.enum(SETTLEMENT_MODES).optional() };
const ruleSpec = z.object({
  eventId: z.string(), question: z.string(), source: z.record(z.string(), z.unknown()), observation: z.record(z.string(), z.unknown()),
  decision: z.record(z.string(), z.unknown()), window: z.object({ opens: time, closes: time }).strict(),
  vintage: z.enum(['first-observed-snapshot', 'initial']).optional(),
  // Rule check reasons that are expected before the release (a 404, an empty list); anything else stops preparation.
  expectPending: z.array(z.string().regex(/^[A-Z0-9_]{1,96}$/)).optional(),
}).strict();
const poolSpec = z.object({
  id: z.string().regex(ID), title: z.string().min(3).max(120), label: z.string().regex(LABEL), closesAt: time, b: ausd,
  ...policy, rules: z.array(ruleSpec).min(2).max(4),
}).strict();
export const batchSchema = z.object({
  schema: z.literal(BATCH_SCHEMA), defaults: z.object(policy).strict().optional(), pools: z.array(poolSpec).min(1),
}).strict().superRefine((value, ctx) => {
  const ids = value.pools.map(p => p.id), labels = value.pools.map(p => p.label);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Pool ids must be unique' });
  if (new Set(labels).size !== labels.length) ctx.addIssue({ code: 'custom', message: 'Pool labels must be unique' });
});
export type MarketBatch = z.infer<typeof batchSchema>;

export const seconds = (value: number | string) => typeof value === 'number' ? value : Date.parse(value) / 1000;
export function atoms(value: string) {
  const [whole, fraction = ''] = value.split('.');
  return (BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))).toString();
}
// Initial funding b * n * ln 2 in collateral atoms, rounded up (the deploy script checks the same total).
export function fundingAtoms(liquidityAtoms: string, questions: number) {
  const LN2 = 693147180559945310n;
  return ((BigInt(liquidityAtoms) * BigInt(questions) * LN2 + 10n ** 18n - 1n) / 10n ** 18n).toString();
}

export function expandPool(batch: MarketBatch, id: string) {
  const parsed = batchSchema.parse(batch), pool = parsed.pools.find(p => p.id === id);
  if (!pool) throw Error(`No pool ${id} in the batch`);
  const d = parsed.defaults ?? {};
  const bond = pool.bond ?? d.bond ?? '1', settlement = pool.settlement ?? d.settlement ?? 'auto';
  const periods = { assertionPeriod: pool.assertionPeriod ?? d.assertionPeriod ?? 43200, challengePeriod: pool.challengePeriod ?? d.challengePeriod ?? 3600,
    votingPeriod: pool.votingPeriod ?? d.votingPeriod ?? 3600 };
  const expectPending: Record<string, string[]> = {};
  const rules = pool.rules.map(r => {
    const opens = seconds(r.window.opens), closes = seconds(r.window.closes);
    const source = JSON.parse(JSON.stringify(r.source));
    if (source.reader && typeof source.reader === 'object') for (const key of ['at', 'until']) if (source.reader[key] !== undefined) source.reader[key] = seconds(source.reader[key]);
    if (r.expectPending?.length) expectPending[r.eventId] = r.expectPending;
    return { schema: 'flurbo.settlement-rule.v1', eventId: r.eventId, question: r.question, source, observation: r.observation, decision: r.decision,
      timing: { scheduledAt: opens, publicationCutoff: closes, correctionCutoff: closes, observationEndsAt: closes, ...periods },
      vintage: r.vintage ?? 'first-observed-snapshot', missingPolicy: 'resolver-timeout-void' };
  });
  return { id: pool.id, title: pool.title, label: pool.label, settlement, closesAt: seconds(pool.closesAt), liquidityAtoms: atoms(pool.b),
    bondAtoms: atoms(bond), ...periods, rules, expectPending };
}
export type ExpandedPool = ReturnType<typeof expandPool>;

export function preparePool(pool: ExpandedPool, selection: { creator: string; reviewers: { name: string; address: string }[] }, now: number) {
  const policy = { creator: selection.creator, reviewers: selection.reviewers, reviewerControl: 'single-operator' as const,
    independentReviewersConfirmed: false, rulesReviewed: true as const, bondAtoms: pool.bondAtoms,
    assertionPeriod: pool.assertionPeriod, challengePeriod: pool.challengePeriod, votingPeriod: pool.votingPeriod };
  const settlementRules = pool.rules;
  return preparePilot({ schema: 'flurbo.pilot-publication.v1', mode: 'deterministic-source-v1', ...policy, settlementRules,
    draft: { schema: 'flurbo.event-draft.v1', status: 'draft', chainId: 10143, clusterId: `${pool.id}-${pool.closesAt}`,
      title: pool.title, closesAt: pool.closesAt, events: settlementRules.map(settlementEvent),
      exceptionPolicy: VOID_POLICY, disputeModel: 'reviewer-panel', disputePolicy: disputePolicy(policy) } }, now, pool.liquidityAtoms);
}

// Rule check outcome for one rule: fine, expected before the release, or a reason to stop.
export function judgeCheck(report: { status: string; sources?: { result: string; reason?: string }[] }, expected: string[] = []) {
  if (report.status === 'ok') return 'ok';
  if (report.status === 'source-error' && report.sources?.every(s => s.result !== 'source-error' || (s.reason && expected.includes(s.reason)))) return 'expected-pending';
  return 'blocked';
}
