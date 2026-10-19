#!/usr/bin/env node
// Rule check: run a draft settlement rule against its live source before a market is prepared.
//
//   node apps/web/scripts/check-settlement-rule.mjs <rule-or-rules.json> [--closes-at <unix seconds>] [--proof <capture.json>]...
//
// Prints, for each rule: whether it is valid, its rule hash, what each source returns right now, and whether the
// market would still be a prediction. Nothing is signed, stored or sent anywhere except the source requests.
// A credentialed source (proof-http.v1) is never fetched: pass sample proof captures with --proof to check them.
// Exit codes: 0 fine, 1 invalid rule, 2 the answer is already public, 3 a source could not be read.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { settlementRuleAuthoringIssues, settlementRuleHash, settlementTimeline, validateSettlementRule } from '../server/settlement-rules.mjs';
import { parseSettlementCapture, retrieveSettlementCapture } from '../server/settlement-evidence.mjs';
import { inspectProofCapture } from '../server/settlement-readers.mjs';
import { HUMAN_QUESTION_SCHEMA, validateHumanQuestion } from './create-hybrid-reality-pilot.mjs';

const WAITING = new Set(['VALUE_MISSING', 'EVM_BLOCK_NOT_YET_AVAILABLE', 'EVM_NOT_FINAL', 'EXTRACTION_MISSING_FIELD']);
const iso = seconds => new Date(seconds * 1000).toISOString();
const FINAL_CHECK = { path: '/dates/0/games/0/status/detailedState', equals: 'Final' };

export function mlbScheduleGame(url) {
  try {
    const parsed = new URL(url), gamePk = parsed.searchParams.get('gamePk');
    return parsed.hostname === 'statsapi.mlb.com' && parsed.pathname === '/api/v1/schedule'
      && /^[0-9]{5,7}$/.test(gamePk || '') ? gamePk : null;
  } catch { return null; }
}

async function readJson(response) {
  if (typeof response.json === 'function') return response.json();
  const chunks = [];
  for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function checkMlbScheduleGame({ url, gamePk, rule, request }) {
  let body;
  try {
    const response = await request(url, { redirect: 'error', headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(12000) });
    if (response.status !== 200) throw Error('status');
    body = await readJson(response);
  } catch { return { result: 'subject-unreadable', gamePk, game: null }; }
  const game = (Array.isArray(body?.dates) ? body.dates : []).flatMap(d => Array.isArray(d?.games) ? d.games : [])
    .find(g => String(g?.gamePk) === gamePk) ?? null;
  if (!game) return { result: 'subject-missing', gamePk, game };
  const state = String(game.status?.detailedState ?? '');
  if (/^(Postponed|Suspended|Cancelled)/.test(state)) return { result: 'subject-postponed', gamePk, game };
  if (!(Date.parse(game.gameDate) / 1000 + 4 * 3600 <= rule.timing.publicationCutoff))
    return { result: 'subject-late', gamePk, game };
  return { result: 'subject-ok', gamePk, game };
}

export const SUBJECT_CHECKS = [{ name: 'mlb-schedule-game', matches: mlbScheduleGame, check: checkMlbScheduleGame }];

function subjectMessage({ result, gamePk, game }, cutoff) {
  if (result === 'subject-missing') return `gamePk ${gamePk} is not in the MLB schedule. The question could never resolve.`;
  if (result === 'subject-postponed')
    return `Game ${gamePk} is ${game.status.detailedState}. Write the question for the rescheduled game or drop it.`;
  if (result === 'subject-late')
    return `Game ${gamePk} starts at ${game.gameDate}, less than 4 hours before the capture cutoff ${iso(cutoff)}. Move the cutoff or drop the question.`;
  return `The MLB schedule for game ${gamePk} could not be read. Check it before preparing the market.`;
}

export async function checkRule(raw, { now = Math.floor(Date.now() / 1000), closesAt = null, request = fetch, proofs = [] } = {}) {
  if (raw?.schema === HUMAN_QUESTION_SCHEMA) {
    try {
      const human = validateHumanQuestion(raw, closesAt);
      return { eventId: human.eventId, status: 'ok', route: 'reality-human',
        window: { opens: iso(human.observationEndsAt) }, sources: [],
        meaning: 'Valid human-route Reality.eth question. Answered on Sepolia after the observation time.' };
    } catch (error) {
      return { eventId: raw?.eventId ?? null, status: 'invalid', message: error.message };
    }
  }
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
    if (rule.source.adapter === 'proof-http.v1') {
      if (!proofs.length) report.sources.push({ url, result: 'proof-required' });
      for (const proof of proofs) {
        try { const { value, timestampS, signers } = inspectProofCapture(rule, proof); report.sources.push({ url, result: 'proof-valid', value, signedAt: iso(timestampS), signers }); }
        catch (error) { report.sources.push({ url, result: 'proof-invalid', reason: error.reason ?? 'PROOF_INVALID' }); report.status = 'source-error'; }
      }
      continue;
    }
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
        row.result = 'already-public'; if (report.status === 'ok') report.status = 'already-public';
      } else row.result = rule.vintage === 'first-observed-snapshot' && now < rule.timing.scheduledAt ? 'current-reading' : 'value-available';
    } catch (error) {
      const reason = error.reason ?? 'SOURCE_ERROR';
      row.result = WAITING.has(reason) ? 'not-yet-available' : 'source-error';
      row.reason = reason;
      if (row.result === 'source-error' && report.status !== 'invalid') report.status = 'source-error';
    }
    report.sources.push(row);
  }
  for (const row of report.sources) {
    if (rule.source.adapter === 'proof-http.v1') break;
    for (const subject of SUBJECT_CHECKS) {
      const gamePk = subject.matches(row.url);
      if (!gamePk) continue;
      const found = await subject.check({ url: row.url, gamePk, rule, request });
      row.subject = { result: found.result, gamePk, gameDate: found.game?.gameDate ?? null,
        detailedState: found.game?.status?.detailedState ?? null };
      if (found.result !== 'subject-ok' && report.status !== 'invalid') {
        report.status = 'invalid';
        report.message = subjectMessage(found, rule.timing.publicationCutoff);
      }
      if (!(rule.source.reader.checks || []).some(c => c.path?.endsWith('/status/detailedState') && c.equals === FINAL_CHECK.equals))
        report.warnings = [`Add a check ${JSON.stringify(FINAL_CHECK)} so a game that is not final reads as missing, not as a result.`];
    }
  }
  report.meaning = {
    ok: 'Valid. Before the window the value is not public yet, as a prediction market needs.',
    'already-public': 'The answer can already be read. Move the window or pick a period that is not published yet.',
    'source-error': 'The source could not be read or did not match the reader settings. Fix the rule before preparing a market.',
    invalid: 'The question cannot resolve as written. Fix it before preparing a market.',
  }[report.status];
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) { console.error('Usage: node apps/web/scripts/check-settlement-rule.mjs <rule-or-rules.json> [--closes-at <unix seconds>] [--proof <capture.json>]...'); process.exit(1); }
  const at = rest.indexOf('--closes-at'), closesAt = at >= 0 ? Number(rest[at + 1]) : null;
  const proofs = [];
  for (let i = 0; i < rest.length; i++) if (rest[i] === '--proof') proofs.push(JSON.parse(await readFile(rest[++i], 'utf8')));
  const input = JSON.parse(await readFile(file, 'utf8'));
  const rules = Array.isArray(input) ? input : Array.isArray(input.settlementRules) ? input.settlementRules : [input];
  const reports = [];
  for (const rule of rules) reports.push(await checkRule(rule, { closesAt, proofs }));
  console.log(JSON.stringify(reports, null, 2));
  process.exit(Math.max(0, ...reports.map(r => ({ ok: 0, invalid: 1, 'already-public': 2, 'source-error': 3 })[r.status])));
}
