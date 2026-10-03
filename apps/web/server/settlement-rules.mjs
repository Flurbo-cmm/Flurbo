import { createHash } from 'node:crypto';
import { validateReaderConfig } from './settlement-readers.mjs';

export const SETTLEMENT_SCHEMA = 'flurbo.settlement-rule.v1';
// General readers (settlement-readers.mjs) are configured by each rule. Defined here, not imported, so either
// module can be loaded first despite their mutual import.
export const GENERAL_ADAPTERS = ['json-api.v1', 'stat-table.v1', 'html-text.v1', 'evm-rpc.v1'];
export const SETTLEMENT_ADAPTERS = ['json-record.v1', 'bls-employment-html.v1', 'fomc-statement-html.v1', 'usgs-earthquake-count.v1', ...GENERAL_ADAPTERS];
const operators = ['gt', 'gte', 'lt', 'lte', 'eq'];
const integer = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 500;
const exactKeys = (object, keys) => object && typeof object === 'object' && !Array.isArray(object)
  && Object.keys(object).every(key => keys.includes(key));
export const digest = value => createHash('sha256').update(value).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw Error('Noncanonical value');
  return encoded;
}
export function decimal(value) {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d{0,35})(?:\.\d{1,18})?$/.test(value)) throw Error('Exact decimal string required');
  const negative = value.startsWith('-'), [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  return { coefficient: BigInt(whole + fraction) * (negative ? -1n : 1n), scale: fraction.length };
}
export function compareDecimal(left, right) {
  const a = decimal(left), b = decimal(right), scale = Math.max(a.scale, b.scale);
  const x = a.coefficient * 10n ** BigInt(scale - a.scale), y = b.coefficient * 10n ** BigInt(scale - b.scale);
  return x < y ? -1 : x > y ? 1 : 0;
}
export function sourceUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash && url.href === value; }
  catch { return false; }
}
export function usgsQuery(rule) {
  const parts = rule.observation.period.split('/');
  const iso = value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.000)?Z$/.test(value || '')
    && Number.isSafeInteger(Date.parse(value) / 1000) && new Date(value).toISOString().replace('.000Z', 'Z') === value.replace('.000Z', 'Z');
  if (parts.length !== 2 || !parts.every(iso)) throw Error('Explicit USGS UTC interval required');
  const [start, end] = parts.map(value => Date.parse(value) / 1000);
  if (start >= end || end - start > 86400 || rule.timing.scheduledAt < end) throw Error('Unsupported USGS interval');
  if (rule.source.urls.length !== 1) throw Error('One exact USGS catalogue query required');
  const url = new URL(rule.source.urls[0]), keys = [...url.searchParams.keys()];
  const expected = { format: 'geojson', starttime: parts[0], endtime: parts[1], eventtype: 'earthquake', orderby: 'time-asc' };
  if (url.origin !== 'https://earthquake.usgs.gov' || url.pathname !== '/fdsnws/event/1/query'
    || keys.length !== 5 || new Set(keys).size !== 5 || Object.entries(expected).some(([key, value]) => url.searchParams.get(key) !== value))
    throw Error('Unsupported USGS query or pagination');
  return { start, end, url: url.href };
}
export function validateSettlementRule(rule) {
  if (!exactKeys(rule, ['schema', 'eventId', 'question', 'source', 'observation', 'decision', 'timing', 'vintage', 'missingPolicy'])
    || rule.schema !== SETTLEMENT_SCHEMA || !text(rule.eventId) || !text(rule.question)) throw Error('Invalid settlement rule');
  const source = rule.source, general = GENERAL_ADAPTERS.includes(source?.adapter);
  if (!exactKeys(source, ['id', 'publisher', 'urls', 'adapter', general ? 'reader' : 'fields']) || !text(source.id) || !text(source.publisher)
    || !SETTLEMENT_ADAPTERS.includes(source.adapter) || !Array.isArray(source.urls) || !source.urls.length || source.urls.length > 32
    || new Set(source.urls).size !== source.urls.length || !source.urls.every(sourceUrl)) throw Error('Unsupported settlement source');
  if (source.adapter === 'json-record.v1') {
    const required = ['id', 'series', 'period', 'unit', 'publishedAt', 'kind', 'value'];
    if (!exactKeys(source.fields, [...required, 'supersedesId']) || !required.every(key => typeof source.fields[key] === 'string')
      || !Object.values(source.fields).every(value => /^\/(?:[^~]|~[01])*$/.test(value) && value.length <= 500)) throw Error('Explicit JSON field paths required');
  } else if (source.fields !== undefined) throw Error('HTML adapter fields are fixed');
  if (!exactKeys(rule.observation, ['series', 'period', 'unit']) || !Object.values(rule.observation).every(text)
    || !['series', 'period', 'unit'].every(key => text(rule.observation[key]))) throw Error('Observation identity required');
  const decision = rule.decision;
  if (!exactKeys(decision, ['type', 'operator', 'value']) || !['number', 'category', 'timestamp'].includes(decision.type)) throw Error('Unsupported decision rule');
  if (decision.type === 'category') {
    if (decision.operator !== 'eq' || !text(decision.value)) throw Error('Invalid category comparison');
  } else if (!operators.includes(decision.operator)) throw Error('Unsupported comparison');
  else if (decision.type === 'number') decimal(decision.value);
  else if (!integer(decision.value)) throw Error('Timestamp comparison uses integer UTC seconds');
  const timing = rule.timing;
  if (!exactKeys(timing, ['scheduledAt', 'publicationCutoff', 'correctionCutoff', 'observationEndsAt', 'assertionPeriod', 'challengePeriod', 'votingPeriod'])
    || !['scheduledAt', 'publicationCutoff', 'correctionCutoff', 'observationEndsAt', 'assertionPeriod', 'challengePeriod', 'votingPeriod'].every(key => integer(timing[key]))
    || timing.publicationCutoff < timing.scheduledAt || timing.correctionCutoff < timing.publicationCutoff
    || timing.observationEndsAt !== timing.correctionCutoff
    || timing.assertionPeriod < 3600 || timing.assertionPeriod > 30 * 86400
    || timing.challengePeriod < 3600 || timing.challengePeriod > 7 * 86400
    || timing.votingPeriod < 3600 || timing.votingPeriod > 7 * 86400
    || !Number.isSafeInteger(timing.observationEndsAt + timing.assertionPeriod + timing.challengePeriod + timing.votingPeriod)) throw Error('Invalid fixed resolver timing');
  if (!['initial', 'initial-with-corrections', 'first-observed-snapshot'].includes(rule.vintage) || rule.missingPolicy !== 'resolver-timeout-void'
    || (rule.vintage !== 'initial-with-corrections' && timing.correctionCutoff !== timing.publicationCutoff)
    || (rule.vintage === 'first-observed-snapshot' && source.adapter !== 'usgs-earthquake-count.v1' && !general)) throw Error('Unsupported vintage or exception policy');
  // General readers are configured by the rule; their settings are checked once the decision and timing are valid.
  if (general) validateReaderConfig(rule);
  if (source.adapter === 'bls-employment-html.v1' && (rule.observation.series !== 'LNS14000000' || rule.observation.unit !== 'percent'
    || decision.type !== 'number' || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(rule.observation.period)
    || source.urls.some(url => !/^https:\/\/www\.bls\.gov\/news\.release\/archives\/empsit_\d{8}\.htm$/.test(url)))) throw Error('Unsupported BLS observation');
  if (source.adapter === 'fomc-statement-html.v1' && (rule.observation.series !== 'announced-target-upper-bound' || rule.observation.unit !== 'percent'
    || decision.type !== 'number' || !/^\d{4}-\d{2}-\d{2}$/.test(rule.observation.period)
    || source.urls.some(url => url !== `https://www.federalreserve.gov/newsevents/pressreleases/monetary${rule.observation.period.replaceAll('-', '')}a.htm`))) throw Error('Unsupported FOMC observation');
  if (source.adapter === 'usgs-earthquake-count.v1') {
    if (rule.observation.series !== 'catalogue-event-count' || rule.observation.unit !== 'events' || decision.type !== 'number'
      || rule.vintage !== 'first-observed-snapshot' || !/^(?:0|[1-9]\d*)$/.test(decision.value)) throw Error('Unsupported USGS observation');
    usgsQuery(rule);
  }
  return rule;
}
export const settlementRuleHash = rule => digest(canonical(validateSettlementRule(rule)));

// Authoring policy, applied when a market is prepared and by the rule check, never when an existing pool settles.
// Catalogues and feeds keep adding and revising records after the interval they describe (EMSC added an M4.2
// earthquake 92 minutes after it happened, after pre-test-v1 had captured its count). A snapshot of an interval
// must therefore wait until the source has settled, so the first retained capture reflects the complete record.
// Chain readers are exempt: evm-rpc.v1 already requires block finality.
export const SNAPSHOT_SETTLE_SECONDS = 3 * 3600;
function intervalEnd(period) {
  const parts = period.split('/');
  if (parts.length !== 2) return null;
  const end = Date.parse(parts[1]);
  return Number.isFinite(end) && /^\d{4}-\d{2}-\d{2}T/.test(parts[1]) ? Math.floor(end / 1000) : null;
}
export function settlementRuleAuthoringIssues(rule) {
  validateSettlementRule(rule);
  const issues = [], end = intervalEnd(rule.observation.period);
  if (rule.vintage === 'first-observed-snapshot' && rule.source.adapter !== 'evm-rpc.v1' && end !== null
    && rule.timing.scheduledAt - end < SNAPSHOT_SETTLE_SECONDS)
    issues.push(`The capture window opens ${Math.round((rule.timing.scheduledAt - end) / 60)} minutes after the observed interval ends. `
      + `Sources add and revise records late, so open it at least ${SNAPSHOT_SETTLE_SECONDS / 3600} hours after the interval.`);
  return issues;
}
export function assertSettlementRuleAuthoring(rule) {
  const issues = settlementRuleAuthoringIssues(rule);
  if (issues.length) throw Error(`${rule.eventId}: ${issues.join(' ')}`);
  return rule;
}

// End-to-end lock estimates use fixed contract deadlines, not a moving date after retrieval.
export function settlementTimeline(rule, closesAt) {
  validateSettlementRule(rule);
  if (!integer(closesAt) || closesAt >= rule.timing.observationEndsAt) throw Error('Trading must close before observation end');
  const t = rule.timing, deadline = t.observationEndsAt + t.assertionPeriod;
  return { closesAt, earliestAssertionAt: t.observationEndsAt, assertionDeadlineExclusive: deadline,
    earliestUnchallengedFinalizationAt: t.observationEndsAt + t.challengePeriod,
    latestUnchallengedFinalizationBefore: deadline + t.challengePeriod,
    latestDisputedTimeoutBefore: deadline + t.challengePeriod + t.votingPeriod,
    missingAssertionVoidAt: deadline, minimumLockSeconds: t.observationEndsAt + t.challengePeriod - closesAt,
    note: 'All transitions require transactions. Delivery waits for every event. Redemption is a separate holder action.' };
}
