import { preparePilot, disputePolicy, VOID_POLICY } from './pilot-config';
import { settlementEvent } from '../../../apps/web/server/settlement-publication.mjs';

// pre-test-v2: two questions settled by the bot with no operator input, on 1 October 2026, delivered before 11:30 UTC
// (17:00 IST). Both satisfy the authoring rules added after pre-test-v1: the NBP fixing is one dated release, not an
// interval, and the Monad count is a chain reading that waits for finality. Thresholds come from recent data so each
// answer is roughly even (NBP: the 30 September rate; Monad: 4,974 to 5,387 across recent half hours).
export const PRE_TEST_V2_LIQUIDITY_ATOMS = '25000000'; // b = 25 test AUSD
const DAY = Date.UTC(2026, 9, 1) / 1000, at = (h: number, m: number) => DAY + h * 3600 + m * 60;
export const PRE_TEST_V2_TIMES = {
  latestClose: at(8, 30),                 // trading closes before the Monad half hour starts
  monad: { from: at(8, 45), until: at(9, 15), captureFrom: at(9, 20), captureUntil: at(9, 32) },
  nbp: { captureFrom: at(9, 50), captureUntil: at(10, 14) }, // NBP publishes table A between 11:45 and 12:15 CEST
  deadline: at(11, 30),
};
const iso = (s: number) => new Date(s * 1000).toISOString().replace('.000Z', 'Z');
const hm = (s: number) => iso(s).slice(11, 16);
const timing = (scheduledAt: number, cutoff: number) => ({ scheduledAt, publicationCutoff: cutoff, correctionCutoff: cutoff, observationEndsAt: cutoff,
  assertionPeriod: 3600, challengePeriod: 3600, votingPeriod: 3600 });
const base = { schema: 'flurbo.settlement-rule.v1', vintage: 'first-observed-snapshot', missingPolicy: 'resolver-timeout-void' };

export function preTestV2Rules() {
  const T = PRE_TEST_V2_TIMES;
  return [
    { ...base, eventId: 'nbp-usd-pln-oct1',
      question: `Will the National Bank of Poland's table A mid rate for USD on 1 October 2026 be at least 3.8449 PLN (the 30 September rate), as published by the NBP API and first captured between ${hm(T.nbp.captureFrom)} and ${hm(T.nbp.captureUntil)} UTC?`,
      source: { id: 'nbp-table-a-usd', publisher: 'Narodowy Bank Polski', urls: ['https://api.nbp.pl/api/exchangerates/rates/a/usd/2026-10-01/?format=json'], adapter: 'json-api.v1',
        reader: { select: '/rates/0/mid', aggregate: 'value', checks: [{ path: '/code', equals: 'USD' }, { path: '/rates/0/effectiveDate', equals: '2026-10-01' }] } },
      observation: { series: 'nbp-table-a-usd-mid', period: '2026-10-01', unit: 'PLN per USD' },
      decision: { type: 'number', operator: 'gte', value: '3.8449' }, timing: timing(T.nbp.captureFrom, T.nbp.captureUntil) },
    { ...base, eventId: 'monad-activity-oct1',
      question: `Will Monad mainnet record at least 5,100 transactions across every 25th block from the first block at or after ${hm(T.monad.from)} UTC to the first block at or after ${hm(T.monad.until)} UTC on 1 October 2026, read from the public Monad RPC between ${hm(T.monad.captureFrom)} and ${hm(T.monad.captureUntil)} UTC?`,
      source: { id: 'monad-mainnet-rpc', publisher: 'Monad Foundation public RPC', urls: ['https://rpc.monad.xyz/'], adapter: 'evm-rpc.v1',
        reader: { chainId: 143, at: T.monad.from, until: T.monad.until, metric: 'tx-count', stride: 25, finalitySeconds: 60 } },
      observation: { series: 'monad-mainnet-sampled-transactions', period: `${iso(T.monad.from)}/${iso(T.monad.until)}`, unit: 'transactions' },
      decision: { type: 'number', operator: 'gte', value: '5100' }, timing: timing(T.monad.captureFrom, T.monad.captureUntil) },
  ];
}

export function preparePreTestV2(selection: { creator: string; reviewers: { name: string; address: string }[] }, now: number, closesAt?: number) {
  // The deploy script requires trading close to be more than an hour after the deployment transaction, so the
  // default leaves about 30 minutes to deploy after preparing.
  const close = closesAt ?? Math.ceil((now + 95 * 60) / 300) * 300;
  if (close <= now + 3600) throw Error('Trading close must be more than an hour away when the pool is deployed');
  if (close > PRE_TEST_V2_TIMES.latestClose) throw Error(`Too late to prepare pre-test-v2: trading would close after ${hm(PRE_TEST_V2_TIMES.latestClose)} UTC and settlement would pass 17:00 IST.`);
  const settlementRules = preTestV2Rules();
  const lastFinal = Math.max(...settlementRules.map(r => r.timing.observationEndsAt)) + 3600;
  if (lastFinal + 600 > PRE_TEST_V2_TIMES.deadline) throw Error('Settlement would not finish before 17:00 IST');
  const policy = { creator: selection.creator, reviewers: selection.reviewers, reviewerControl: 'single-operator' as const,
    independentReviewersConfirmed: false, rulesReviewed: true, bondAtoms: '1000000', assertionPeriod: 3600, challengePeriod: 3600, votingPeriod: 3600 };
  return preparePilot({ schema: 'flurbo.pilot-publication.v1', mode: 'deterministic-source-v1', ...policy, settlementRules,
    draft: { schema: 'flurbo.event-draft.v1', status: 'draft', chainId: 10143, clusterId: `pre-test-v2-${close}`,
      title: 'pre-test-v2: macro and Monad', closesAt: close, events: settlementRules.map(settlementEvent),
      exceptionPolicy: VOID_POLICY, disputeModel: 'reviewer-panel', disputePolicy: disputePolicy(policy) } }, now, PRE_TEST_V2_LIQUIDITY_ATOMS);
}
