#!/usr/bin/env node
// Prover for proof-http.v1 rules. Runs on the operator's machine, never in the web service.
//
//   node prove.mjs --catalog <hybrid-markets.json> --pool <pool id> --event <index> [--mode zk|tee] [--out FILE] [--submit ORIGIN] [--watch]
//   node prove.mjs --rule <rules.json> [--index N] [--out FILE] [--mode zk|tee] [--discover]
//
// Environment: FLURBO_RECLAIM_APP_ID, FLURBO_RECLAIM_APP_SECRET, FLURBO_PROOF_CREDENTIAL_<LABEL> and, with
// --submit, FLURBO_PROOF_SUBMIT_TOKEN. None of them is ever printed. Output is one JSON line per result.
// Exit codes: 0 done, 1 usage or invalid rule, 3 proof generation failed, 4 outside the capture window,
// 5 local verification failed, 6 submission rejected.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ReclaimClient } from '@reclaimprotocol/zk-fetch';
import { validateSettlementRule } from '../../apps/web/server/settlement-rules.mjs';
import { recoverClaimSigners } from '../../apps/web/server/source-proof.mjs';
import { createProofCapture, credentialEnvName, proveForRule, scrub, submitProofCapture } from './capture.mjs';

const USAGE = `Usage:
  node prove.mjs --catalog <hybrid-markets.json> --pool <pool id> --event <index> [--mode zk|tee] [--out FILE] [--submit ORIGIN] [--watch]
  node prove.mjs --rule <rules.json> [--index N] [--out FILE] [--mode zk|tee] [--discover]`;
const WITH_VALUE = ['--catalog', '--pool', '--event', '--rule', '--index', '--mode', '--out', '--submit'];
const FLAGS = ['--watch', '--discover'];
const RETRY_SECONDS = 600;
const iso = seconds => new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');
const index = value => (/^(?:0|[1-9]\d{0,3})$/.test(value ?? '') ? Number(value) : null);

function parse(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (FLAGS.includes(name)) options[name.slice(2)] = true;
    else if (WITH_VALUE.includes(name) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) options[name.slice(2)] = argv[++i];
    else return null;
  }
  return options;
}

export async function main(argv, { env = process.env, clientClass = ReclaimClient, request = fetch, now = () => Math.floor(Date.now() / 1000),
  sleep = ms => new Promise(done => setTimeout(done, ms)), print = line => console.log(line), error = line => console.error(line),
  readJson = async file => JSON.parse(await readFile(file, 'utf8')), save = (file, text) => writeFile(file, text, { flag: 'wx' }) } = {}) {
  const say = value => print(JSON.stringify(value));
  const o = parse(argv), mode = o?.mode ?? 'zk';
  const catalogMode = o?.catalog !== undefined;
  if (!o || catalogMode === (o.rule !== undefined) || !['zk', 'tee'].includes(mode)
    || (catalogMode ? o.pool === undefined || index(o.event) === null || o.discover || o.index !== undefined
      : o.pool !== undefined || o.event !== undefined || o.submit !== undefined || o.watch || (o.index !== undefined && index(o.index) === null))) {
    error(USAGE); return 1;
  }
  let rule;
  try {
    if (catalogMode) rule = (await readJson(o.catalog)).pools?.find(pool => pool.id === o.pool)?.prepared?.draft?.events?.[index(o.event)]?.rule;
    else { const input = await readJson(o.rule); rule = (Array.isArray(input) ? input : [input])[index(o.index ?? '0')]; }
  } catch { rule = undefined; }
  if (!rule) { error(USAGE); say({ status: 'invalid', message: 'No such rule' }); return 1; }
  try {
    validateSettlementRule(rule);
    if (rule.source.adapter !== 'proof-http.v1') throw Error('Rule does not use proof-http.v1');
  } catch (e) { say({ status: 'invalid', message: e.message }); return 1; }
  const names = ['FLURBO_RECLAIM_APP_ID', 'FLURBO_RECLAIM_APP_SECRET', credentialEnvName(rule.source.reader.credential.label), ...(o.submit ? ['FLURBO_PROOF_SUBMIT_TOKEN'] : [])];
  const missing = names.filter(name => !env[name]);
  if (missing.length) { say({ status: 'missing_environment', names: missing }); return 1; }
  const appId = env.FLURBO_RECLAIM_APP_ID, appSecret = env.FLURBO_RECLAIM_APP_SECRET, credential = env[names[2]], submitToken = env.FLURBO_PROOF_SUBMIT_TOKEN;
  const hidden = [appId, appSecret, credential, submitToken];
  const input = { rule, credential, appId, appSecret, mode, clientClass };
  let written = false;
  const store = async capture => {
    if (o.out && !written) { await save(o.out, JSON.stringify(capture, null, 2) + '\n'); written = true; }
  };
  const fail = e => {
    if (e?.code === 'OUTSIDE_WINDOW') { say({ status: 'outside_window' }); return 4; }
    if (e?.code === 'SUBMISSION_REJECTED') { say({ status: 'rejected', message: scrub(e.message, hidden) }); return 6; }
    if (typeof e?.reason === 'string' && /^[A-Z0-9_]{1,96}$/.test(e.reason)) { say({ status: 'failed', reason: e.reason }); return 5; }
    say({ status: 'failed', message: scrub(e?.detail ? `${e.message}: ${e.detail}` : e?.message ?? 'Unknown failure', hidden) });
    return 3;
  };

  if (o.discover) {
    try {
      const capture = await createProofCapture(input);
      await store(capture);
      say({ status: 'discovered', signers: recoverClaimSigners(JSON.parse(capture.body).proof) });
      return 0;
    } catch (e) { return fail(e); }
  }
  const attempt = async () => {
    const proved = await proveForRule({ ...input, now: now(), window: catalogMode });
    await store(proved.capture);
    const summary = { ruleHash: proved.ruleHash, signedAt: iso(proved.signedAt), value: proved.value };
    if (!o.submit) { say({ status: 'proved', ...summary }); return; }
    const reply = await submitProofCapture({ origin: o.submit, token: submitToken, ruleHash: proved.ruleHash, capture: proved.capture, request });
    say({ status: 'stored', ...summary, firstFetchedAt: reply.firstFetchedAt });
  };
  if (!o.watch) {
    try { await attempt(); return 0; } catch (e) { return fail(e); }
  }
  for (;;) {
    const at = now();
    if (at > rule.timing.publicationCutoff) { say({ status: 'window_closed' }); return 4; }
    if (at < rule.timing.scheduledAt) { await sleep(Math.min(RETRY_SECONDS, rule.timing.scheduledAt - at) * 1000); continue; }
    try { await attempt(); return 0; } catch (e) { fail(e); await sleep(RETRY_SECONDS * 1000); }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main(process.argv.slice(2));
