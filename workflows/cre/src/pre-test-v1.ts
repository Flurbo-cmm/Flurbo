import { preparePilot, disputePolicy, VOID_POLICY } from './pilot-config';
import { settlementEvent } from '../../../apps/web/server/settlement-publication.mjs';

// pre-test-v1: four questions from four sources, settled by the bot with no operator input, all on 30 September
// 2026 and before 11:30 UTC (17:00 IST). Pairs: the NBP USD/PLN fixing (a macro rate built from market quotes
// around 09:00 UTC) with Monad mainnet activity in the half hour around those quotes; USGS earthquakes with the
// EMSC catalogue over the same hour. Thresholds come from recent data so each answer is roughly even.
export const PRE_TEST_LIQUIDITY_ATOMS = '25000000'; // b = 25 test AUSD: about 69.3 test AUSD of funding for four questions
const DAY = Date.UTC(2026, 8, 30) / 1000, at = (h: number, m: number) => DAY + h * 3600 + m * 60;
export const PRE_TEST_TIMES = {
  latestClose: at(8, 30),                 // quake hour must end by 09:30 and settle before the NBP question
  monad: { from: at(8, 45), until: at(9, 15), captureFrom: at(9, 20), captureUntil: at(9, 32) },
  nbp: { captureFrom: at(9, 50), captureUntil: at(10, 14) }, // NBP publishes table A between 11:45 and 12:15 CEST
  deadline: at(11, 30),
};
const iso = (s: number) => new Date(s * 1000).toISOString().replace('.000Z', 'Z');
const hm = (s: number) => iso(s).slice(11, 16);
const timing = (scheduledAt: number, cutoff: number) => ({ scheduledAt, publicationCutoff: cutoff, correctionCutoff: cutoff, observationEndsAt: cutoff,
  assertionPeriod: 3600, challengePeriod: 3600, votingPeriod: 3600 });
const base = { schema: 'flurbo.settlement-rule.v1', vintage: 'first-observed-snapshot', missingPolicy: 'resolver-timeout-void' };

export function preTestRules(closesAt: number) {
  const T = PRE_TEST_TIMES, quakeFrom = closesAt, quakeUntil = closesAt + 3600;
  const usgs = new URL('https://earthquake.usgs.gov/fdsnws/event/1/query');
  for (const [k, v] of Object.entries({ format: 'geojson', starttime: iso(quakeFrom), endtime: iso(quakeUntil), minmagnitude: '2.5', eventtype: 'earthquake', orderby: 'time-asc' })) usgs.searchParams.set(k, v);
  const emsc = new URL('https://www.seismicportal.eu/fdsnws/event/1/query');
  for (const [k, v] of Object.entries({ format: 'json', start: iso(quakeFrom), end: iso(quakeUntil), minmag: '3' })) emsc.searchParams.set(k, v);
  const usgsCapture = [quakeUntil + 1800, quakeUntil + 1800 + 720], emscCapture = [quakeUntil + 2100, quakeUntil + 2100 + 720];
  return [
    { ...base, eventId: 'nbp-usd-pln',
      question: `Will the National Bank of Poland's table A mid rate for USD on 30 September 2026 be at least 3.8537 PLN (the 29 September rate), as published by the NBP API and first captured between ${hm(T.nbp.captureFrom)} and ${hm(T.nbp.captureUntil)} UTC?`,
      source: { id: 'nbp-table-a-usd', publisher: 'Narodowy Bank Polski', urls: ['https://api.nbp.pl/api/exchangerates/rates/a/usd/2026-09-30/?format=json'], adapter: 'json-api.v1',
        reader: { select: '/rates/0/mid', aggregate: 'value', checks: [{ path: '/code', equals: 'USD' }, { path: '/rates/0/effectiveDate', equals: '2026-09-30' }] } },
      observation: { series: 'nbp-table-a-usd-mid', period: '2026-09-30', unit: 'PLN per USD' },
      decision: { type: 'number', operator: 'gte', value: '3.8537' }, timing: timing(T.nbp.captureFrom, T.nbp.captureUntil) },
    { ...base, eventId: 'monad-activity',
      question: `Will Monad mainnet record at least 4,500 transactions across every 25th block from the first block at or after ${hm(T.monad.from)} UTC to the first block at or after ${hm(T.monad.until)} UTC on 30 September 2026, read from the public Monad RPC between ${hm(T.monad.captureFrom)} and ${hm(T.monad.captureUntil)} UTC?`,
      source: { id: 'monad-mainnet-rpc', publisher: 'Monad Foundation public RPC', urls: ['https://rpc.monad.xyz/'], adapter: 'evm-rpc.v1',
        reader: { chainId: 143, at: T.monad.from, until: T.monad.until, metric: 'tx-count', stride: 25, finalitySeconds: 60 } },
      observation: { series: 'monad-mainnet-sampled-transactions', period: `${iso(T.monad.from)}/${iso(T.monad.until)}`, unit: 'transactions' },
      decision: { type: 'number', operator: 'gte', value: '4500' }, timing: timing(T.monad.captureFrom, T.monad.captureUntil) },
    { ...base, eventId: 'usgs-m25-hour',
      question: `Will the USGS earthquake catalogue, first captured between ${hm(usgsCapture[0])} and ${hm(usgsCapture[1])} UTC, list at least 2 earthquakes of magnitude 2.5 or more worldwide with origin times from ${hm(quakeFrom)} to ${hm(quakeUntil)} UTC on 30 September 2026?`,
      source: { id: 'usgs-fdsn-m25', publisher: 'United States Geological Survey', urls: [usgs.href], adapter: 'json-api.v1',
        reader: { select: '/features', aggregate: 'count', checks: [{ path: '/type', equals: 'FeatureCollection' }] } },
      observation: { series: 'usgs-earthquakes-m2.5-plus', period: `${iso(quakeFrom)}/${iso(quakeUntil)}`, unit: 'earthquakes' },
      decision: { type: 'number', operator: 'gte', value: '2' }, timing: timing(usgsCapture[0], usgsCapture[1]) },
    { ...base, eventId: 'emsc-m3-hour',
      question: `Will the EMSC earthquake catalogue, first captured between ${hm(emscCapture[0])} and ${hm(emscCapture[1])} UTC, list at least 5 earthquakes of magnitude 3.0 or more worldwide with origin times from ${hm(quakeFrom)} to ${hm(quakeUntil)} UTC on 30 September 2026?`,
      source: { id: 'emsc-fdsn-m3', publisher: 'European-Mediterranean Seismological Centre', urls: [emsc.href], adapter: 'json-api.v1',
        reader: { select: '/features', aggregate: 'count', checks: [{ path: '/type', equals: 'FeatureCollection' }] } },
      observation: { series: 'emsc-earthquakes-m3-plus', period: `${iso(quakeFrom)}/${iso(quakeUntil)}`, unit: 'earthquakes' },
      decision: { type: 'number', operator: 'gte', value: '5' }, timing: timing(emscCapture[0], emscCapture[1]) },
  ];
}

// pre-test-v1 was deployed once, on 30 September 2026. Its catalogue captures open 30 and 35 minutes after the
// counted hour, which the authoring policy now refuses (EMSC added an earthquake after the capture), so the
// template only reproduces that publication; a new collection must open catalogue captures 3 hours later.
export function preparePreTest(selection: { creator: string; reviewers: { name: string; address: string }[] }, now: number, closesAt?: number,
  { reproduce = false } = {}) {
  // The deploy script requires trading close to be more than an hour after the deployment transaction, so the
  // default leaves about 30 minutes to deploy after preparing.
  const close = closesAt ?? Math.ceil((now + 95 * 60) / 300) * 300;
  if (close <= now + 3600) throw Error('Trading close must be more than an hour away when the pool is deployed');
  if (close > PRE_TEST_TIMES.latestClose) throw Error(`Too late to prepare pre-test-v1: trading would close after ${hm(PRE_TEST_TIMES.latestClose)} UTC and settlement would pass 17:00 IST.`);
  const settlementRules = preTestRules(close);
  const lastFinal = Math.max(...settlementRules.map(r => r.timing.observationEndsAt)) + 3600;
  if (lastFinal + 600 > PRE_TEST_TIMES.deadline) throw Error('Settlement would not finish before 17:00 IST');
  const policy = { creator: selection.creator, reviewers: selection.reviewers, reviewerControl: 'single-operator' as const,
    independentReviewersConfirmed: false, rulesReviewed: true, bondAtoms: '1000000', assertionPeriod: 3600, challengePeriod: 3600, votingPeriod: 3600 };
  return preparePilot({ schema: 'flurbo.pilot-publication.v1', mode: 'deterministic-source-v1', ...policy, settlementRules,
    draft: { schema: 'flurbo.event-draft.v1', status: 'draft', chainId: 10143, clusterId: `pre-test-v1-${close}`,
      title: 'pre-test-v1: macro, Monad and earthquakes', closesAt: close, events: settlementRules.map(settlementEvent),
      exceptionPolicy: VOID_POLICY, disputeModel: 'reviewer-panel', disputePolicy: disputePolicy(policy) } }, now, PRE_TEST_LIQUIDITY_ATOMS, { reproduce });
}
