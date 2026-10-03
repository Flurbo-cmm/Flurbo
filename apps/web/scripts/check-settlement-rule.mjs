#!/usr/bin/env node
// Rule check: run a draft settlement rule against its live source before a market is prepared.
//
//   node apps/web/scripts/check-settlement-rule.mjs <rule-or-rules.json> [--closes-at <unix seconds>]
//
// Prints, for each rule: whether it is valid, its rule hash, what each source returns right now, and whether the
// market would still be a prediction. Nothing is signed, stored or sent anywhere except the source requests.
// Exit codes: 0 fine, 1 invalid rule, 2 the answer is already public, 3 a source could not be read.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { settlementRuleAuthoringIssues, settlementRuleHash, settlementTimeline, validateSettlementRule } from '../server/settlement-rules.mjs';
import { parseSettlementCapture, retrieveSettlementCapture } from '../server/settlement-evidence.mjs';

const WAITING = new Set(['VALUE_MISSING', 'EVM_BLOCK_NOT_YET_AVAILABLE', 'EVM_NOT_FINAL', 'EXTRACTION_MISSING_FIELD']);
const iso = seconds => new Date(seconds * 1000).toISOString();

export async function checkRule(raw, { now = Math.floor(Date.now() / 1000), closesAt = null, request = fetch } = {}) {
  let rule;
  try { rule = validateSettlementRule(raw); } catch (error) { return { eventId: raw?.eventId ?? null, status: 'invalid', message: error.message }; }
  const issues = settlementRuleAuthoringIssues(rule);
  if (issues.length) return { eventId: rule.eventId, status: 'invalid', message: issues.join(' ') };
  const report = { eventId: rule.eventId, status: 'ok', ruleHash: settlementRuleHash(rule), adapter: rule.source.adapter,
    window: { opens: iso(rule.timing.scheduledAt), captureCutoff: iso(rule.timing.publicationCutoff) }, sources: [] };
  if (closesAt !== null) {
    try { report.timeline = Object.fromEntries(Object.entries(settlementTimeline(rule, closesAt)).map(([k, v]) => [k, typeof v === 'number' && v > 1e9 ? iso(v) : v])); }
    catch (error) { report.status = 'invalid'; report.message = error.message; return report; }
  }
  for (const url of rule.source.urls) {
    const row = { url };
    try {
      const capture = await retrieveSettlementCapture(rule, url, { request, now: () => now });
      row.bytes = capture.bytes;
      if (capture.bytes > 500_000) row.warning = 'Large response. Narrow the query: evidence is stored for every capture.';
      const record = parseSettlementCapture(rule, { ...capture, fetchedAt: now }, now);
      row.value = record.value; row.unit = rule.observation.unit;
      if (rule.vintage === 'initial') row.publishedAt = iso(record.publishedAt);
      // A release already published before the observation window is a known answer, not a prediction. Snapshot
      // rules are decided by the first capture inside their window, so an earlier reading is only informational:
      // check that it can still change (a count over a future window, a price, a block not yet produced).
      if (rule.vintage === 'initial' && record.publishedAt < rule.timing.scheduledAt) {
        row.result = 'already-public'; if (report.status !== 'source-error') report.status = 'already-public';
      } else row.result = rule.vintage === 'first-observed-snapshot' && now < rule.timing.scheduledAt ? 'current-reading' : 'value-available';
    } catch (error) {
      const reason = error.reason ?? 'SOURCE_ERROR';
      row.result = WAITING.has(reason) ? 'not-yet-available' : 'source-error';
      row.reason = reason;
      if (row.result === 'source-error') report.status = 'source-error';
    }
    report.sources.push(row);
  }
  report.meaning = {
    ok: 'Valid. Before the window the value is not public yet, as a prediction market needs.',
    'already-public': 'The answer can already be read. Move the window or pick a period that is not published yet.',
    'source-error': 'The source could not be read or did not match the reader settings. Fix the rule before preparing a market.',
  }[report.status];
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) { console.error('Usage: node apps/web/scripts/check-settlement-rule.mjs <rule-or-rules.json> [--closes-at <unix seconds>]'); process.exit(1); }
  const at = rest.indexOf('--closes-at'), closesAt = at >= 0 ? Number(rest[at + 1]) : null;
  const input = JSON.parse(await readFile(file, 'utf8'));
  const rules = Array.isArray(input) ? input : Array.isArray(input.settlementRules) ? input.settlementRules : [input];
  const reports = [];
  for (const rule of rules) reports.push(await checkRule(rule, { closesAt }));
  console.log(JSON.stringify(reports, null, 2));
  process.exit(Math.max(0, ...reports.map(r => ({ ok: 0, invalid: 1, 'already-public': 2, 'source-error': 3 })[r.status])));
}
