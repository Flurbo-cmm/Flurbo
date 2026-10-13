import { createHash, timingSafeEqual } from 'node:crypto';
import { settlementRuleHash } from './settlement-rules.mjs';
import { parseSettlementCapture } from './settlement-evidence.mjs';

// Upload service for proof-http.v1 captures. The prover runs on the operator's machine and holds the source
// credential; the web service only accepts finished proofs, verifies them again against the rule listed in the
// catalog, and keeps them in the shared capture store for the settlement worker.
export const PROOF_CAPTURE_PATH = '/api/settlement/proof-captures';
export const MAX_PROOF_SUBMISSION_BYTES = 300_000;
const CAPTURE_KEYS = ['requestedUrl', 'finalUrl', 'fetchedAt', 'status', 'contentType', 'complete', 'bytes', 'body', 'sha256'];
const sha = value => createHash('sha256').update(value).digest();
const reply = (status, body) => ({ status, body });

export function proofCaptureRules(pools) {
  const rules = new Map();
  for (const pool of pools) for (const event of pool?.prepared?.draft?.events ?? [])
    if (event?.rule?.source?.adapter === 'proof-http.v1') rules.set(settlementRuleHash(event.rule), event.rule);
  return rules;
}

export function proofCaptureService({ rules, captureStore, token, now = () => Math.floor(Date.now() / 1000) }) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw Error('Proof submission token must be 32 to 128 URL-safe characters');
  if (!(rules instanceof Map) || typeof captureStore?.put !== 'function') throw Error('Proof capture service configuration incomplete');
  const expected = sha(token);
  const authorized = authorization => timingSafeEqual(sha(/^Bearer (\S{1,256})$/.exec(authorization ?? '')?.[1] ?? ''), expected);
  return { size: rules.size, authorized,
    async submit({ authorization, body }) {
      if (!authorized(authorization)) return reply(401, { error: 'Proof submission unauthorized' });
      if (typeof body !== 'string' || Buffer.byteLength(body) > MAX_PROOF_SUBMISSION_BYTES) return reply(413, { error: 'Payload too large' });
      let parsed;
      try { parsed = JSON.parse(body); } catch { return reply(400, { error: 'Invalid proof submission' }); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).sort().join() !== 'capture,ruleHash'
        || typeof parsed.ruleHash !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.ruleHash)
        || !parsed.capture || typeof parsed.capture !== 'object' || Array.isArray(parsed.capture)) return reply(400, { error: 'Invalid proof submission' });
      const rule = rules.get(parsed.ruleHash);
      if (!rule) return reply(404, { error: 'Rule not accepting proofs' });
      const at = now();
      if (at > rule.timing.observationEndsAt) return reply(409, { error: 'Capture window closed' });
      const capture = Object.fromEntries(CAPTURE_KEYS.map(key => [key, parsed.capture[key]]));
      try { parseSettlementCapture(rule, capture, at); }
      catch (error) {
        return reply(422, { error: 'Proof capture rejected', reason: /^[A-Z0-9_]{1,96}$/.test(error?.reason ?? '') ? error.reason : 'PROOF_CAPTURE_INVALID' });
      }
      try {
        const kept = await captureStore.put(parsed.ruleHash, capture);
        return reply(200, { status: 'stored', ruleHash: parsed.ruleHash, firstFetchedAt: kept.firstFetchedAt, latestFetchedAt: kept.latestFetchedAt });
      } catch { return reply(503, { error: 'Proof capture not stored' }); }
    } };
}
