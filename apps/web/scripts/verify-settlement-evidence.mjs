#!/usr/bin/env node
// Replay tool for challengers and jurors. It re-verifies a settlement evidence packet with no credential and no
// secret: the rule hash is checked, the evaluation is run again from the retained captures, and for TLS proofs
// the attestor signatures are checked again.
//
//   node apps/web/scripts/verify-settlement-evidence.mjs <https URL or file> --rule-hash <64 hex>
//
// The input is a pilot evidence body (as served at /api/pilot/evidence/<hash>) or a settlement packet.
// Prints one JSON line. Exit code 0 when verified, 1 otherwise.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonical, digest } from '../server/settlement-rules.mjs';
import { verifySettlementPacket } from '../server/settlement-evidence.mjs';
import { inspectProofCapture } from '../server/settlement-readers.mjs';
import { verifyDerivedCaptures } from '../server/settlement-pdf.mjs';

const MAX_BYTES = 16_000_000;
const fail = reason => { throw Object.assign(Error(reason), { reason }); };
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

async function fetchText(url, request) {
  const response = await request(url, { redirect: 'error', signal: AbortSignal.timeout(12_000), headers: { Accept: 'application/json' } });
  if (response.status !== 200 || response.redirected || !response.body) fail('EVIDENCE_UNAVAILABLE');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > MAX_BYTES) fail('EVIDENCE_TOO_LARGE'); chunks.push(chunk); }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); } catch { return fail('EVIDENCE_FORMAT_UNSUPPORTED'); }
}
const parse = text => { try { return JSON.parse(text); } catch { return fail('EVIDENCE_FORMAT_UNSUPPORTED'); } };

export async function verifyEvidence(input, { ruleHash, request = fetch }) {
  const expected = typeof ruleHash === 'string' ? ruleHash.replace(/^0x/, '').toLowerCase() : '';
  if (!hex(expected)) fail('RULE_HASH_REQUIRED');
  let text;
  if (/^https?:\/\//i.test(input)) { if (!/^https:\/\//i.test(input)) fail('EVIDENCE_FORMAT_UNSUPPORTED'); text = await fetchText(input, request); }
  else text = await readFile(input, 'utf8');
  const document = parse(text);
  let packet, claimedHash = null;
  if (document?.schema === 'flurbo.settlement-packet.v1') packet = document;
  else if (document?.schema === 'flurbo.pilot-evidence.v1') {
    const attachment = typeof document.attachment === 'string' ? parse(document.attachment) : document.attachment;
    claimedHash = attachment?.packetHash ?? null;
    if (attachment?.packet) packet = attachment.packet;
    else if (typeof attachment?.packetURI === 'string' && /^https:\/\//i.test(attachment.packetURI)) packet = parse(await fetchText(attachment.packetURI, request));
    else fail('EVIDENCE_FORMAT_UNSUPPORTED');
  } else fail('EVIDENCE_FORMAT_UNSUPPORTED');
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) fail('EVIDENCE_FORMAT_UNSUPPORTED');
  const packetHash = digest(canonical(packet));
  if (claimedHash !== null && claimedHash !== packetHash) fail('PACKET_BINDING_FAILED');
  verifySettlementPacket(packet, { packetHash, expectedRuleHash: expected });
  await verifyDerivedCaptures(packet.rule, packet.captures);
  const adapter = packet.rule.source.adapter;
  const result = { status: 'verified', outcome: packet.outcome, measuredValue: packet.measuredValue, selectedRecordId: packet.selectedRecordId, adapter };
  if (adapter === 'proof-http.v1') {
    const selected = packet.records.at(-1).provenance.sha256, capture = packet.captures.find(item => item.sha256 === selected);
    result.signers = inspectProofCapture(packet.rule, capture).signers;
  }
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [input, flag, ruleHash, ...extra] = process.argv.slice(2);
  if (!input || flag !== '--rule-hash' || !ruleHash || extra.length) {
    console.error('Usage: node apps/web/scripts/verify-settlement-evidence.mjs <https URL or file> --rule-hash <64 hex>');
    process.exit(1);
  }
  try { console.log(JSON.stringify(await verifyEvidence(input, { ruleHash }))); }
  catch (error) { console.log(JSON.stringify({ status: 'failed', reason: error.reason ?? 'EVIDENCE_INVALID' })); process.exit(1); }
}
