import { keccak256, stringToHex } from 'viem';
import { canonical, digest, settlementRuleHash } from './settlement-rules.mjs';
import { archiveSettlementProposal, evaluateSettlement, parseSettlementCapture, retrieveSettlementCapture, verifySettlementPacket } from './settlement-evidence.mjs';
import { DETERMINISTIC_MODE, validateSettlementManifest } from './settlement-publication.mjs';
import { settlementPublicOrigin } from './settlement-persistence.mjs';

const failure = reason => { throw Object.assign(Error(reason), { reason }); };
const identity = packet => canonical({ ruleHash: packet.ruleHash, outcome: packet.outcome,
  selectedRecordId: packet.selectedRecordId, measuredValue: packet.measuredValue,
  records: packet.records.map(({ provenance, ...record }) => record) });

/** Validate publicly retrievable archive bytes, not merely a locally generated URL. */
export async function verifyPublicSettlementEvidence(evidence, archive, { origin, request = fetch } = {}) {
  settlementPublicOrigin(origin);
  if (!/^0x[0-9a-f]{64}$/.test(evidence?.hash || '') || evidence.uri !== `${origin}/api/pilot/evidence/${evidence.hash}`) failure('PUBLIC_EVIDENCE_BINDING_FAILED');
  const expected = await archive.get(evidence.hash);
  if (typeof expected !== 'string' || keccak256(stringToHex(expected)) !== evidence.hash || Buffer.byteLength(expected) > 100000) failure('PUBLIC_EVIDENCE_BINDING_FAILED');
  const controller = new AbortController();
  let response;
  try {
    response = await request(evidence.uri, { redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } });
    if (response.status !== 200 || response.redirected || (response.url && response.url !== evidence.uri) || !response.body
      || response.headers.has('content-range') || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) failure('PUBLIC_EVIDENCE_UNAVAILABLE');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 100000) failure('PUBLIC_EVIDENCE_TOO_LARGE'); chunks.push(chunk); }
    const length = response.headers.get('content-length');
    if (!response.headers.get('content-encoding') && length !== null && (!/^\d+$/.test(length) || Number(length) !== size)) failure('PUBLIC_EVIDENCE_INCOMPLETE');
    const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    if (body !== expected || keccak256(stringToHex(body)) !== evidence.hash) failure('PUBLIC_EVIDENCE_BINDING_FAILED');
    return JSON.parse(body);
  } catch (error) {
    controller.abort(); try { if (response?.body && !response.body.locked) await response.body.cancel(); } catch { /* Preserve original failure. */ }
    throw error;
  }
}

/** No signer dependency. Sources cannot select an outcome, transaction or new rule. */
// retainedCache (optional, process lifetime): rule hashes whose first snapshot is already retained. Captures are never
// deleted, so a retained rule stays retained; the cache only saves re-reading its capture history on every cycle.
export function deterministicEvidence({ manifest, owner, command, archive, captureStore, packetStore, origin,
  request = fetch, now = () => Math.floor(Date.now() / 1000), retainedCache = null }) {
  if (manifest.publication?.mode !== DETERMINISTIC_MODE) throw Error('Explicit deterministic publication required');
  const rules = validateSettlementManifest(manifest);
  settlementPublicOrigin(origin);
  if (!captureStore?.list || !captureStore.put || !captureStore.recordAttempt || !captureStore.latestAttempt
    || !packetStore?.get || !packetStore.verifyPublic || !archive?.put || !archive.get || typeof command !== 'function') throw Error('Durable settlement stores required');
  const key = ruleHash => `flurbo:settlement:v1:proposal:${digest(canonical({ owner: owner.toLowerCase(), pool: manifest.pool, draftHash: manifest.draftHash, ruleHash }))}`;
  async function verifyFrozen(saved, rule) {
    const ruleHash = settlementRuleHash(rule);
    if (saved.schema !== 'flurbo.frozen-proposal.v1' || saved.ruleHash !== ruleHash) failure('FROZEN_PROPOSAL_CHANGED');
    const body = await verifyPublicSettlementEvidence(saved, archive, { origin, request });
    if (body.draftHash !== manifest.draftHash || body.eventId !== rule.eventId || ![1,2].includes(body.outcome)
      || body.uploader.toLowerCase() !== owner.toLowerCase()) failure('PUBLIC_EVIDENCE_BINDING_FAILED');
    const attachment = JSON.parse(body.attachment);
    const packet = attachment.packet || await packetStore.verifyPublic(attachment.packetURI, { request });
    verifySettlementPacket(packet, { packetHash: saved.packetHash, expectedRuleHash: ruleHash });
    if (attachment.packetHash !== saved.packetHash || identity(packet) !== saved.identity || packet.outcome !== body.outcome) failure('PUBLIC_EVIDENCE_BINDING_FAILED');
    return { hash: saved.hash, uri: saved.uri, outcome: body.outcome };
  }
  async function collect(state) {
    const results = [];
    for (let event = 0; event < rules.length; event++) {
      const rule = rules[event], hash = settlementRuleHash(rule), at = now();
      if (state.delivered || state.cases[event].phase !== 0 || at >= rule.timing.observationEndsAt + rule.timing.assertionPeriod) continue;
      if (rule.vintage === 'first-observed-snapshot') {
        if (at < rule.timing.scheduledAt) { results.push({ event, status: 'waiting-for-snapshot-window' }); continue; }
        const selected = retainedCache?.has(hash) || (await captureStore.list(hash)).some(capture => {
          try { const record = parseSettlementCapture(rule, capture, at); return capture.fetchedAt >= rule.timing.scheduledAt
            && capture.fetchedAt <= rule.timing.publicationCutoff && record.publishedAt >= rule.timing.scheduledAt && record.publishedAt <= rule.timing.publicationCutoff; }
          catch { return false; }
        });
        // This policy commits to its first complete retained snapshot. Refreshing it would change the question.
        if (selected) { retainedCache?.add(hash); await captureStore.recordAttempt(hash, { at, ok: true, issues: [] }); results.push({ event, status: 'snapshot-retained' }); continue; }
        if (at > rule.timing.publicationCutoff) {
          await captureStore.recordAttempt(hash, { at, ok: false, issues: ['SNAPSHOT_WINDOW_MISSED'] });
          results.push({ event, status: 'unresolved', issues: ['SNAPSHOT_WINDOW_MISSED'] }); continue;
        }
      }
      const attempts = await Promise.all(rule.source.urls.map(async url => {
        try {
          const capture = await retrieveSettlementCapture(rule, url, { request, now });
          parseSettlementCapture(rule, capture, now());
          await captureStore.put(hash, capture);
          return null;
        } catch (error) { return /^[A-Z0-9_]{1,96}$/.test(error.reason || '') ? error.reason : 'SOURCE_CAPTURE_FAILED'; }
      }));
      const issues = [...new Set(attempts.filter(Boolean))];
      await captureStore.recordAttempt(hash, { at: now(), ok: !issues.length, issues });
      results.push({ event, status: issues.length ? 'unresolved' : 'captured', issues });
    }
    return results;
  }
  async function proposal(event) {
    validateSettlementManifest(manifest); // Recheck mutable caller data before every proposal.
    const rule = rules[event]; if (!rule) throw Error('Unknown deterministic event');
    const ruleHash = settlementRuleHash(rule), at = now(), attempt = await captureStore.latestAttempt(ruleHash);
    if (!attempt?.ok || attempt.at > at || at - attempt.at > 900) return null;
    const captures = await captureStore.list(ruleHash), evaluation = evaluateSettlement(rule, captures, { now: at });
    if (evaluation.status !== 'ready') return null;
    let frozen = await command('GET', key(ruleHash));
    if (!frozen) {
      const result = await archiveSettlementProposal({ rule, expectedRuleHash: ruleHash, captures, now: at, archive, packetStore, owner, draftHash: manifest.draftHash });
      if (!result.evidence) return null;
      frozen = JSON.stringify({ schema: 'flurbo.frozen-proposal.v1', ruleHash, hash: result.evidence.hash, uri: result.evidence.uri,
        packetHash: result.evaluation.packetHash, identity: identity(result.evaluation.packet) });
      await command('SET', key(ruleHash), frozen, 'NX');
      if (await command('GET', key(ruleHash)) !== frozen) failure('PROPOSAL_PERSISTENCE_CONFLICT');
    }
    const saved = JSON.parse(frozen);
    if (saved.schema !== 'flurbo.frozen-proposal.v1' || saved.ruleHash !== ruleHash || saved.identity !== identity(evaluation.packet)) failure('FROZEN_PROPOSAL_CHANGED');
    return verifyFrozen(saved,rule);
  }
  async function verifyPending(pending) {
    validateSettlementManifest(manifest);
    const rule=rules[pending.event];if(!rule)failure('PENDING_EVIDENCE_UNAVAILABLE');
    const ruleHash=settlementRuleHash(rule),at=now(),attempt=await captureStore.latestAttempt(ruleHash);
    if(!attempt?.ok||attempt.at>at||at-attempt.at>900)failure('PENDING_SOURCE_UNAVAILABLE');
    const evaluated=evaluateSettlement(rule,await captureStore.list(ruleHash),{now:at});
    if(evaluated.status!=='ready')failure('PENDING_SOURCE_NO_LONGER_READY');
    const frozen=await command('GET',key(ruleHash));
    if(!frozen)failure('PENDING_EVIDENCE_UNAVAILABLE');
    const saved=JSON.parse(frozen);
    if(saved.identity!==identity(evaluated.packet))failure('PENDING_SOURCE_CHANGED');
    const evidence=await verifyFrozen(saved,rule);
    if(evidence.hash!==pending.evidenceHash||evidence.outcome!==pending.outcome
      ||(pending.evidenceURI!==undefined&&evidence.uri!==pending.evidenceURI))failure('PENDING_EVIDENCE_BINDING_FAILED');
    return evidence;
  }
  return { collect, proposal, verifyPending };
}
