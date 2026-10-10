import { ReclaimClient } from '@reclaimprotocol/zk-fetch';
import { digest, settlementRuleHash, validateSettlementRule } from '../../apps/web/server/settlement-rules.mjs';
import { parseSettlementCapture } from '../../apps/web/server/settlement-evidence.mjs';
import { inspectProofCapture } from '../../apps/web/server/settlement-readers.mjs';
import { PROOF_CONTEXT_ADDRESS, proofContextMessage } from '../../apps/web/server/source-proof.mjs';

// Proof captures for proof-http.v1 rules. This runs on the operator's machine: the source credential and the
// Reclaim application credentials stay here. The web service only ever sees the finished proof, which it
// verifies again before storing.
const SUBMIT_PATH = '/api/settlement/proof-captures';
const CLAIM_KEYS = ['provider', 'parameters', 'owner', 'timestampS', 'context', 'identifier', 'epoch'];
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;
const fail = (message, code) => Object.assign(Error(message), { code });

export const scrub = (message, secrets) => secrets.filter(text).reduce((out, secret) => out.replaceAll(secret, '[hidden]'), String(message ?? '')).slice(0, 300);
export const credentialEnvName = label => `FLURBO_PROOF_CREDENTIAL_${label.toUpperCase().replaceAll('-', '_')}`;

function checked(rule) {
  validateSettlementRule(rule);
  if (rule.source.adapter !== 'proof-http.v1') throw Error('Rule does not use proof-http.v1');
  return settlementRuleHash(rule);
}

export function proofRequest(rule, ruleHash, credentialValue, mode = 'zk') {
  const r = rule.source.reader, credential = r.credential;
  if (!text(credentialValue) || !['zk', 'tee'].includes(mode)) throw Error('Invalid proof request');
  const publicOptions = { method: r.request.method,
    ...(r.request.headers && Object.keys(r.request.headers).length ? { headers: { ...r.request.headers } } : {}),
    ...(r.request.method === 'POST' && r.request.body !== undefined ? { body: r.request.body } : {}),
    context: { contextAddress: PROOF_CONTEXT_ADDRESS, contextMessage: proofContextMessage(ruleHash) }, useTee: mode === 'tee' };
  const secretOptions = { ...(credential.kind === 'header' ? { headers: { [credential.name]: credentialValue } } : { cookieStr: credentialValue }),
    responseMatches: structuredClone(r.responseMatches), responseRedactions: structuredClone(r.responseRedactions) };
  return { url: rule.source.urls[0], publicOptions, secretOptions };
}

export async function createProofCapture({ rule, credential, appId, appSecret, mode = 'zk', clientClass = ReclaimClient }) {
  const ruleHash = checked(rule);
  if (!text(appId) || !text(appSecret)) throw Error('Reclaim application credentials required');
  const { url, publicOptions, secretOptions } = proofRequest(rule, ruleHash, credential, mode);
  let proof;
  try { proof = await new clientClass(appId, appSecret).zkFetch(url, publicOptions, secretOptions); }
  catch (error) {
    throw Object.assign(fail('Proof generation failed', 'PROOF_GENERATION_FAILED'), { detail: scrub(error?.message, [credential, appSecret, appId]) });
  }
  if (!proof?.claimData || !Array.isArray(proof.signatures)) throw fail('No proof produced', 'PROOF_GENERATION_FAILED');
  const claimData = Object.fromEntries(CLAIM_KEYS.map(key => [key, proof.claimData[key]]));
  const witnesses = (Array.isArray(proof.witnesses) ? proof.witnesses : []).filter(w => typeof w?.id === 'string' && typeof w?.url === 'string').map(w => ({ id: w.id, url: w.url }));
  const body = JSON.stringify({ schema: 'flurbo.proof-capture.v1',
    proof: { identifier: proof.identifier, claimData, signatures: proof.signatures, ...(witnesses.length ? { witnesses } : {}) } });
  return { requestedUrl: url, finalUrl: url, fetchedAt: claimData.timestampS, status: 200, contentType: 'application/json',
    complete: true, body, bytes: Buffer.byteLength(body), sha256: digest(body) };
}

export async function proveForRule({ rule, credential, appId, appSecret, mode = 'zk', now = Math.floor(Date.now() / 1000), window = true, clientClass = ReclaimClient }) {
  const ruleHash = checked(rule);
  if (window && (now < rule.timing.scheduledAt || now > rule.timing.publicationCutoff)) throw fail('Outside the capture window', 'OUTSIDE_WINDOW');
  const capture = await createProofCapture({ rule, credential, appId, appSecret, mode, clientClass });
  if (window) parseSettlementCapture(rule, capture, now + 5);
  const { value, timestampS, signers } = inspectProofCapture(rule, capture);
  return { ruleHash, capture, value, signedAt: timestampS, signers };
}

export async function submitProofCapture({ origin, token, ruleHash, capture, request = fetch }) {
  if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(origin) && !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin)) throw Error('Submission origin must be an https origin');
  if (!text(token)) throw Error('Submission token required');
  const response = await request(origin + SUBMIT_PATH, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ruleHash, capture }) });
  let reply = {};
  try { reply = await response.json(); } catch { /* A non-JSON failure is reported by status alone. */ }
  if (response.status !== 200) throw fail(`Proof submission rejected: ${response.status} ${scrub(reply?.reason ?? reply?.error ?? 'unknown', [token])}`, 'SUBMISSION_REJECTED');
  return reply;
}
