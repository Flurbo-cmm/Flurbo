import { canonical, compareDecimal, decimal, digest, settlementRuleHash, sourceUrl, usgsQuery, validateSettlementRule } from './settlement-rules.mjs';
import { GENERAL_ADAPTERS, readGeneralRecord, readerAccept, retrieveEvmCapture } from './settlement-readers.mjs';

const MAX_BYTES = 2_000_000;
const kinds = ['initial', 'correction', 'revision', 'cancelled', 'correction-notice'];
const validTime = value => Number.isSafeInteger(value) && value >= 0;
const issue = reason => { throw Object.assign(Error(reason), { reason }); };
const one = (values, reason) => { const distinct = [...new Set(values)]; if (distinct.length !== 1) issue(reason); return distinct[0]; };
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function utc(year, month, day, hour, minute) {
  const date = new Date(Date.UTC(year, month, day, hour, minute));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) issue('PUBLICATION_DATE_INVALID');
  return Math.floor(date.getTime() / 1000);
}
function htmlText(body) {
  return body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/g, '&')
    .replace(/&#(?:8211|8209);|&ndash;|[\u2011\u2013]/g, '-').replace(/\s+/g, ' ').trim();
}
function pointer(document, path) {
  let value = document;
  for (const token of path.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, token)) issue('EXTRACTION_MISSING_FIELD');
    value = value[token];
  }
  return value;
}
function strictJSON(body) {
  let document;
  try { document = JSON.parse(body); } catch { issue('EXTRACTION_INVALID_JSON'); }
  // JSON.parse silently keeps the last duplicate member. Refuse that ambiguity,
  // including escaped spellings of the same key and duplicates outside selected fields.
  let offset = 0;
  const space = () => { while (/\s/.test(body[offset] || '') && offset < body.length) offset++; };
  const string = () => {
    const match = /^"(?:\\.|[^"\\])*"/.exec(body.slice(offset));
    if (!match) issue('EXTRACTION_INVALID_JSON'); offset += match[0].length; return JSON.parse(match[0]);
  };
  const value = (depth = 0) => {
    if (depth > 64) issue('EXTRACTION_TOO_DEEP'); space();
    if (body[offset] === '{') {
      offset++; space(); const keys = new Set();
      while (body[offset] !== '}') {
        const key = string(); if (keys.has(key)) issue('EXTRACTION_DUPLICATE_FIELD'); keys.add(key);
        space(); offset++; value(depth + 1); space(); if (body[offset] === ',') { offset++; space(); } else break;
      }
      offset++;
    } else if (body[offset] === '[') {
      offset++; space(); while (body[offset] !== ']') { value(depth + 1); space(); if (body[offset] === ',') { offset++; space(); } else break; } offset++;
    } else if (body[offset] === '"') string();
    else while (offset < body.length && !/[\s,\]}]/.test(body[offset])) offset++;
  };
  value();
  return document;
}
function jsonRecord(body, rule) {
  const document = strictJSON(body);
  return Object.fromEntries(Object.entries(rule.source.fields).map(([key, path]) => [key, pointer(document, path)]));
}
function usgsRecord(body, rule) {
  const document = strictJSON(body), query = usgsQuery(rule), metadata = document?.metadata;
  if (document?.type !== 'FeatureCollection' || !Array.isArray(document.features) || metadata?.status !== 200
    || !Number.isSafeInteger(metadata.count) || metadata.count < 0 || metadata.count > 20000 || metadata.count !== document.features.length
    || !Number.isSafeInteger(metadata.generated) || metadata.generated < 0 || metadata.url !== query.url) issue('USGS_CATALOGUE_INCOMPLETE');
  const ids = new Set();
  for (const feature of document.features) {
    if (feature?.type !== 'Feature' || typeof feature.id !== 'string' || !feature.id || feature.id.length > 128 || ids.has(feature.id)
      || feature.properties?.type !== 'earthquake' || !Number.isSafeInteger(feature.properties.time)
      || feature.properties.time < query.start * 1000 || feature.properties.time > query.end * 1000) issue('USGS_EVENT_INVALID');
    ids.add(feature.id);
  }
  return { id: `usgs-catalogue:${metadata.generated}:${digest(body)}`, ...rule.observation, kind: 'initial', value: String(metadata.count),
    publishedAt: Math.floor(metadata.generated / 1000), timestampMeaning: 'catalogue-generation-not-event-publication' };
}
function blsRecord(body, rule) {
  const text = htmlText(body), [year, month] = rule.observation.period.split('-').map(Number), monthName = months[month - 1];
  if (!text.includes(`THE EMPLOYMENT SITUATION -- ${monthName.toUpperCase()} ${year}`)) issue('OBSERVATION_IDENTITY_MISMATCH');
  // This narrow parser handles the archived initial release sentence, never a revised time series.
  const values = [...text.matchAll(new RegExp(`In ${monthName}, (?:both )?the unemployment rate, at ([0-9]+\\.[0-9]+) percent`, 'g'))].map(match => match[1]);
  const value = one(values, 'EXTRACTION_AMBIGUOUS_OR_MISSING');
  const dates = [...text.matchAll(/8:30 a\.m\. \((ET|EST|EDT)\) (?:Monday|Tuesday|Wednesday|Thursday|Friday), ([A-Z][a-z]+) (\d{1,2}), (\d{4})/g)];
  if (dates.length !== 1) issue('PUBLICATION_DATE_INVALID');
  const [, zone, name, dayText, yearText] = dates[0], releaseMonth = months.indexOf(name), releaseYear = Number(yearText), day = Number(dayText);
  if (releaseMonth < 0 || releaseYear < 2007) issue('PUBLICATION_DATE_INVALID');
  // Do not guess ET daylight-saving conversion from the month or host timezone.
  const localDay = utc(releaseYear, releaseMonth, day, 0, 0);
  const secondSundayMarch = 8 + (7 - new Date(Date.UTC(releaseYear, 2, 8)).getUTCDay()) % 7;
  const firstSundayNovember = 1 + (7 - new Date(Date.UTC(releaseYear, 10, 1)).getUTCDay()) % 7;
  const daylight = localDay >= utc(releaseYear, 2, secondSundayMarch, 0, 0) && localDay < utc(releaseYear, 10, firstSundayNovember, 0, 0);
  if ((zone === 'EST' && daylight) || (zone === 'EDT' && !daylight)) issue('PUBLICATION_DATE_INVALID');
  const publishedAt = utc(releaseYear, releaseMonth, day, daylight ? 12 : 13, 30);
  const id = one([...text.matchAll(/USDL-\d{2}-\d{4}/g)].map(match => match[0]), 'RELEASE_ID_MISSING');
  return { id, ...rule.observation, kind: 'initial', value, publishedAt };
}
function fedRecord(body, rule) {
  const text = htmlText(body), [year, month, day] = rule.observation.period.split('-').map(Number);
  const articleDates = [...body.matchAll(/<p\b[^>]*\bclass=["'][^"']*\barticle__time\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/gi)].map(match => htmlText(match[1]));
  if (one(articleDates, 'PUBLICATION_DATE_INVALID') !== `${months[month - 1]} ${day}, ${year}` || !text.includes('Federal Reserve issues FOMC statement')) issue('OBSERVATION_IDENTITY_MISMATCH');
  const zones = [...text.matchAll(/For release at 2:00 p\.m\. (EST|EDT)/g)].map(match => match[1]);
  const zone = one(zones, 'PUBLICATION_DATE_INVALID');
  const ranges = [...text.matchAll(/(?:lower|raise|maintain) the target range for the federal funds rate (?:by [0-9/-]+ percentage point )?(?:to|at) ([0-9]+(?:-[0-9]+\/[0-9]+)?) to ([0-9]+(?:-[0-9]+\/[0-9]+)?) percent/g)];
  if (ranges.length !== 1) issue('EXTRACTION_AMBIGUOUS_OR_MISSING');
  const upper = ranges[0][2], match = /^(\d+)(?:-(\d+)\/(\d+))?$/.exec(upper);
  let value = match[1];
  if (match[2]) {
    const numerator = Number(match[2]), denominator = Number(match[3]);
    if (![2, 4, 8].includes(denominator) || numerator >= denominator) issue('EXTRACTION_UNSUPPORTED_FRACTION');
    const fraction = String(1000 * numerator / denominator).padStart(3, '0').replace(/0+$/, '');
    value = `${BigInt(match[1])}.${fraction || '0'}`;
  }
  return { id: `fomc-statement:${rule.observation.period}`, ...rule.observation, kind: 'initial', value,
    publishedAt: utc(year, month - 1, day, zone === 'EST' ? 19 : 18, 0) };
}
/** Captures must be provided by a trusted bounded retriever. No network or LLM calls occur here. */
export function parseSettlementCapture(rule, capture, now) {
  validateSettlementRule(rule);
  if (!validTime(now) || !capture || !validTime(capture.fetchedAt) || capture.fetchedAt > now) issue('CAPTURE_TIME_INVALID');
  if (!rule.source.urls.includes(capture.requestedUrl) || capture.finalUrl !== capture.requestedUrl) issue('SOURCE_URL_MISMATCH');
  if (capture.status !== 200 || capture.complete !== true || typeof capture.body !== 'string') issue('CAPTURE_INCOMPLETE');
  const bytes = Buffer.byteLength(capture.body);
  if (bytes === 0 || bytes > MAX_BYTES || capture.bytes !== bytes || capture.sha256 !== digest(capture.body)) issue('CAPTURE_INTEGRITY_FAILED');
  const json = ['json-record.v1', 'usgs-earthquake-count.v1'].includes(rule.source.adapter), general = GENERAL_ADAPTERS.includes(rule.source.adapter);
  // General readers check their own formats (JSON, CSV, SDMX, JSON-stat, HTML, chain bundles).
  if (!general && !(json ? /^application\/(?:json|[^;]+\+json)(?:;|$)/i : /^text\/html(?:;|$)/i).test(capture.contentType || '')) issue('CONTENT_TYPE_MISMATCH');
  const record = general ? readGeneralRecord(rule, capture) : rule.source.adapter === 'json-record.v1' ? jsonRecord(capture.body, rule)
    : rule.source.adapter === 'usgs-earthquake-count.v1' ? usgsRecord(capture.body, rule)
    : rule.source.adapter === 'bls-employment-html.v1' ? blsRecord(capture.body, rule) : fedRecord(capture.body, rule);
  if (!['series', 'period', 'unit'].every(key => record[key] === rule.observation[key])) issue('OBSERVATION_IDENTITY_MISMATCH');
  if (typeof record.id !== 'string' || !record.id || record.id.length > 500 || !kinds.includes(record.kind)
    || !validTime(record.publishedAt) || record.publishedAt > capture.fetchedAt) issue('RECORD_METADATA_INVALID');
  if (record.kind === 'correction' || record.kind === 'correction-notice') {
    if (typeof record.supersedesId !== 'string' || !record.supersedesId || record.supersedesId === record.id) issue('CORRECTION_TARGET_MISSING');
  }
  if (['initial', 'correction', 'revision'].includes(record.kind)) {
    try {
      if (rule.decision.type === 'number') decimal(record.value);
      else if (rule.decision.type === 'timestamp') { if (!validTime(record.value)) issue('VALUE_INVALID'); }
      else if (typeof record.value !== 'string' || !record.value || record.value.length > 500) issue('VALUE_INVALID');
    } catch { issue('VALUE_INVALID'); }
  }
  return { ...record, provenance: { sourceId: rule.source.id, requestedUrl: capture.requestedUrl, finalUrl: capture.finalUrl,
    fetchedAt: capture.fetchedAt, sha256: capture.sha256, bytes, adapter: rule.source.adapter } };
}

function evaluate(rule, captures, { now, finalized = false, archivedAt } = {}) {
  validateSettlementRule(rule);
  if (!validTime(now)) throw Error('Evaluation time required');
  const ruleHash = settlementRuleHash(rule), t = rule.timing;
  const result = (status, reason, extra = {}) => ({ schema: 'flurbo.settlement-evaluation.v1', eventId: rule.eventId, ruleHash, evaluatedAt: now, status, reason, ...extra });
  if (finalized) return result('terminal', 'ALREADY_FINALIZED');
  if (now >= t.observationEndsAt + t.assertionPeriod) return result('timeout', 'ASSERTION_DEADLINE_PASSED', { action: 'finalize-timeout', timeoutOutcome: 3 });
  if (now < t.observationEndsAt) return result('waiting', 'OBSERVATION_WINDOW_OPEN');
  if (!Array.isArray(captures) || captures.length > 100) return result('unresolved', 'CAPTURE_SET_INVALID');
  if (captures.length && !rule.source.urls.every(url => captures.some(capture => capture?.requestedUrl === url))) return result('unresolved', 'SOURCE_COVERAGE_MISSING');
  const records = [], errors = [];
  for (const capture of captures) {
    try { const record = parseSettlementCapture(rule, capture, archivedAt ?? now); if (record.publishedAt <= now) records.push(record); }
    catch (error) { errors.push(error.reason || 'CAPTURE_INVALID'); }
  }
  // Failed or conflicting captures are never silently discarded to obtain a convenient answer.
  if (errors.length) return result('unresolved', 'SOURCE_CAPTURE_FAILED', { issues: [...new Set(errors)] });
  // A correction policy cannot be satisfied using only an early copy of the release.
  // Every declared correction-monitor source must have a complete capture at/after the cutoff.
  if (records.length && rule.vintage === 'initial-with-corrections'
    && !rule.source.urls.every(url => captures.some(capture => capture.requestedUrl === url && capture.fetchedAt >= t.correctionCutoff)))
    return result('unresolved', 'CORRECTION_MONITOR_STALE');
  let initials = records.filter(record => record.kind === 'initial' && record.publishedAt <= t.publicationCutoff);
  // A general reader's release must come after the observation window opens, which is after trading closed.
  // An answer that was already public when trading closed is not a prediction, so it never settles the market.
  if (GENERAL_ADAPTERS.includes(rule.source.adapter) && rule.vintage === 'initial') {
    const early = initials.filter(record => record.publishedAt < t.scheduledAt);
    initials = initials.filter(record => record.publishedAt >= t.scheduledAt);
    if (!initials.length && early.length) return result('unresolved', 'RELEASED_BEFORE_OBSERVATION_WINDOW', { action: 'wait-for-evidence-or-timeout' });
  }
  if (rule.vintage === 'first-observed-snapshot') {
    initials = initials.filter(record => record.publishedAt >= t.scheduledAt
      && record.provenance.fetchedAt >= t.scheduledAt && record.provenance.fetchedAt <= t.publicationCutoff);
    const first = Math.min(...initials.map(record => record.provenance.fetchedAt));
    initials = initials.filter(record => record.provenance.fetchedAt === first);
    if (!initials.length) return result('unresolved', 'SNAPSHOT_NOT_RETAINED_IN_WINDOW', { action: 'wait-for-evidence-or-timeout' });
  }
  if (!initials.length) {
    const cancelled = records.some(record => record.kind === 'cancelled' && record.publishedAt <= t.publicationCutoff);
    return result('unresolved', cancelled ? 'SOURCE_CANCELLED' : records.some(record => record.kind === 'initial') ? 'RELEASE_AFTER_PUBLICATION_CUTOFF' : 'RELEASE_UNAVAILABLE', { action: 'wait-for-evidence-or-timeout' });
  }
  // One immutable initial identity. Two claimed initial values are a conflict, not a majority vote.
  const identity = record => canonical({ id: record.id, kind: record.kind, value: record.value, publishedAt: record.publishedAt, supersedesId: record.supersedesId ?? '' });
  if (new Set(initials.map(identity)).size !== 1) return result('unresolved', 'INITIAL_SOURCE_CONFLICT');
  let selected = initials[0];
  const used = [selected];
  if (records.some(record => record.kind === 'cancelled' && record.publishedAt <= t.publicationCutoff)) return result('unresolved', 'SOURCE_CANCELLED');
  if (rule.vintage === 'initial-with-corrections') {
    const corrections = records.filter(record => ['correction', 'correction-notice'].includes(record.kind) && record.publishedAt <= t.correctionCutoff)
      .sort((a, b) => a.publishedAt - b.publishedAt || a.id.localeCompare(b.id));
    const seen = new Map();
    const timestamps = new Map();
    for (const record of corrections) {
      const key = identity(record);
      if (seen.has(record.id)) { if (seen.get(record.id) !== key) return result('unresolved', 'CORRECTION_SOURCE_CONFLICT'); else continue; }
      seen.set(record.id, key);
      if (timestamps.has(record.publishedAt) && timestamps.get(record.publishedAt) !== record.id) return result('unresolved', 'CORRECTION_ORDER_AMBIGUOUS');
      timestamps.set(record.publishedAt, record.id);
      if (record.supersedesId !== selected.id || record.publishedAt < selected.publishedAt) return result('unresolved', 'CORRECTION_CHAIN_INVALID');
      selected = record; used.push(record);
    }
    if (selected.kind === 'correction-notice') return result('unresolved', 'CORRECTION_WITHOUT_REPLACEMENT');
  }
  const d = rule.decision, comparison = d.type === 'number' ? compareDecimal(selected.value, d.value)
    : selected.value === d.value ? 0 : selected.value < d.value ? -1 : 1;
  const yes = { gt: comparison > 0, gte: comparison >= 0, lt: comparison < 0, lte: comparison <= 0, eq: comparison === 0 }[d.operator];
  const packet = { schema: 'flurbo.settlement-packet.v1', ruleHash, rule, evaluatedAt: now, outcome: yes ? 2 : 1,
    context: archivedAt === undefined ? 'live-evaluation' : 'retrospective-replay', ...(archivedAt === undefined ? {} : { replayedAt: archivedAt }),
    selectedRecordId: selected.id, measuredValue: selected.value, records: used,
    captures: captures.map(capture => ({ ...capture })),
    excluded: records.filter(record => !used.includes(record)).map(record => ({ id: record.id, kind: record.kind, publishedAt: record.publishedAt })),
    notice: 'Reproducible source observation, not proof of publisher truth or a finalized contract result.' };
  return result('ready', 'RULE_EVALUATED', { outcome: packet.outcome, packet, packetHash: digest(canonical(packet)) });
}

export function evaluateSettlement(rule, captures, { now, finalized = false } = {}) {
  return evaluate(rule, captures, { now, finalized });
}
// Archived bytes retrieved today can test historical rules, but never prove what a trader knew then.
// The worker must use evaluateSettlement, never this retrospective helper.
export function replaySettlement(rule, captures, { asOf, replayedAt, finalized = false } = {}) {
  if (!validTime(replayedAt) || !validTime(asOf) || replayedAt < asOf) throw Error('Invalid historical replay time');
  const result = evaluate(rule, captures, { now: asOf, finalized, archivedAt: replayedAt });
  return { ...result, context: 'retrospective-replay', replayedAt, liveSubmissionEligible: false };
}

export function verifySettlementPacket(packet, { packetHash, expectedRuleHash } = {}) {
  if (!packet || packet.context !== 'live-evaluation' || typeof expectedRuleHash !== 'string'
    || packet.ruleHash !== expectedRuleHash || settlementRuleHash(packet.rule) !== expectedRuleHash
    || digest(canonical(packet)) !== packetHash) issue('PACKET_BINDING_FAILED');
  const repeated = evaluateSettlement(packet.rule, packet.captures, { now: packet.evaluatedAt });
  if (repeated.status !== 'ready' || repeated.packetHash !== packetHash) issue('PACKET_REPLAY_FAILED');
  return repeated;
}

/** Future worker integration seam. The caller must verify expectedRuleHash against its immutable manifest. */
export async function archiveSettlementProposal({ rule, expectedRuleHash, captures, now, archive, owner, draftHash, packetStore }) {
  if (settlementRuleHash(rule) !== expectedRuleHash) issue('PACKET_BINDING_FAILED');
  const evaluated = evaluateSettlement(rule, captures, { now });
  if (evaluated.status !== 'ready') return { evaluation: evaluated, evidence: null };
  verifySettlementPacket(evaluated.packet, { packetHash: evaluated.packetHash, expectedRuleHash });
  let attachment = JSON.stringify({ packet: evaluated.packet, packetHash: evaluated.packetHash });
  // The existing public evidence archive caps attachments at 12,000 characters.
  // Larger raw captures need a separately supplied durable, content-addressed store.
  if (attachment.length > 12000) {
    if (!packetStore?.put || !packetStore?.get) issue('EVIDENCE_PACKET_STORE_REQUIRED');
    const stored = await packetStore.put(evaluated.packet, evaluated.packetHash);
    if (stored?.sha256 !== evaluated.packetHash || !sourceUrl(stored.uri) || stored.uri.length > 2048) issue('EVIDENCE_PACKET_STORAGE_FAILED');
    const retained = await packetStore.get(stored.uri);
    verifySettlementPacket(retained, { packetHash: evaluated.packetHash, expectedRuleHash });
    attachment = JSON.stringify({ schema: 'flurbo.settlement-packet-reference.v1', ruleHash: expectedRuleHash,
      packetHash: evaluated.packetHash, packetURI: stored.uri, outcome: evaluated.outcome,
      selectedRecordId: evaluated.packet.selectedRecordId, measuredValue: evaluated.packet.measuredValue });
    if (attachment.length > 12000) issue('EVIDENCE_PACKET_STORAGE_FAILED');
  }
  const evidence = await archive.put({ eventId: rule.eventId, outcome: evaluated.outcome,
    statement: `${rule.question} Deterministic rule result: ${evaluated.outcome === 2 ? 'YES' : 'NO'}. Measured value: ${evaluated.packet.measuredValue} ${rule.observation.unit}.`,
    sourceURL: evaluated.packet.records.at(-1).provenance.finalUrl,
    attachment }, owner, draftHash);
  return { evaluation: evaluated, evidence: { ...evidence, outcome: evaluated.outcome } };
}

// A bounded transport helper deliberately refuses redirects and caller-selected non-allowlisted URLs.
export async function retrieveSettlementCapture(rule, url, { request = fetch, now = () => Math.floor(Date.now() / 1000) } = {}) {
  validateSettlementRule(rule);
  if (!rule.source.urls.includes(url)) issue('SOURCE_URL_MISMATCH');
  if (rule.source.adapter === 'evm-rpc.v1') return retrieveEvmCapture(rule, url, { request, now });
  const controller = new AbortController();
  const response = await request(url, { redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
    headers: { Accept: GENERAL_ADAPTERS.includes(rule.source.adapter) ? readerAccept(rule) : ['json-record.v1', 'usgs-earthquake-count.v1'].includes(rule.source.adapter) ? 'application/json' : 'text/html', 'Cache-Control': 'no-cache' } });
  try {
    if (response.status !== 200 || !response.body || response.redirected || (response.url && response.url !== url)) issue('SOURCE_FETCH_FAILED');
    if (response.headers.has('content-range')) issue('SOURCE_PARTIAL_RESPONSE');
    const encoded = response.headers.get('content-encoding');
    const length = response.headers.get('content-length');
    let declared;
    if (length !== null && (!encoded || encoded.toLowerCase() === 'identity')) {
      if (!/^(?:0|[1-9]\d*)$/.test(length) || !Number.isSafeInteger(Number(length))) issue('SOURCE_LENGTH_INVALID');
      declared = Number(length); if (declared > MAX_BYTES) issue('SOURCE_TOO_LARGE');
    }
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > MAX_BYTES) issue('SOURCE_TOO_LARGE'); chunks.push(chunk); }
    if (declared !== undefined && declared !== bytes) issue('SOURCE_LENGTH_MISMATCH');
    if (!bytes) issue('SOURCE_EMPTY');
    let body; try { body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); } catch { issue('SOURCE_ENCODING_INVALID'); }
    return { requestedUrl: url, finalUrl: response.url || url, fetchedAt: now(), status: response.status,
      contentType: response.headers.get('content-type'), complete: true, bytes, body, sha256: digest(body) };
  } catch (error) {
    controller.abort();
    try { if (response.body && !response.body.locked) await response.body.cancel(); } catch { /* Retain the original retrieval failure. */ }
    throw error;
  }
}
