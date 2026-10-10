import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { privateKeyToAccount } from 'viem/accounts';
import { canonical, digest, settlementRuleAuthoringIssues, settlementRuleHash, validateSettlementRule } from '../server/settlement-rules.mjs';
import { evaluateSettlement, parseSettlementCapture, retrieveSettlementCapture, verifySettlementPacket } from '../server/settlement-evidence.mjs';
import { jcs } from '../server/source-proof.mjs';
import { inspectProofCapture } from '../server/settlement-readers.mjs';
import { checkRule } from '../scripts/check-settlement-rule.mjs';
import { verifyEvidence } from '../scripts/verify-settlement-evidence.mjs';
import { ATTESTOR, ATTESTOR_KEY, MATCH_URL, OTHER_KEY, T0, proofCapture, proofRule, withBody } from './proof-fixture.ts';

type Made = Parameters<typeof proofCapture>[1];
const reason = (fn: () => unknown) => { try { fn(); } catch (e: any) { return e.reason ?? e.message; } return 'no error'; };
const read = (rule: any, capture: any, now = T0 + 6 * 3600) => parseSettlementCapture(rule, capture, now);
const value = async (rule: any, options?: Made, now?: number) => read(rule, await proofCapture(rule, options), now).value;
const why = async (rule: any, options?: Made, now?: number) => { const capture = await proofCapture(rule, options); return reason(() => read(rule, capture, now)); };
const OTHER = privateKeyToAccount(OTHER_KEY).address.toLowerCase();
const EXTRACTED = { matchId: '123', status: 'FINISHED', winner: 'HOME_TEAM', homeGoals: '2', awayGoals: '1' };
const params = (rule: any, change: (p: any) => void = () => {}) => {
  const r = rule.source.reader, p: any = { body: '', headers: r.request.headers, method: r.request.method,
    responseMatches: r.responseMatches, responseRedactions: r.responseRedactions, url: MATCH_URL };
  change(p);
  return JSON.stringify(p);
};

test('a proof settles a credentialed category, a number and a sum', async () => {
  const rule = proofRule(), capture = await proofCapture(rule);
  assert.equal(read(rule, capture, T0 + 120).value, 'HOME_TEAM');
  const number = (reader: object) => proofRule({ reader, decision: { type: 'number', operator: 'gte', value: '2' } });
  assert.equal(await value(number({ value: { param: 'homeGoals' } })), '2');
  assert.equal(await value(number({ value: { sum: ['homeGoals', 'awayGoals'] } })), '3');
  assert.equal(await value(number({ value: { difference: ['homeGoals', 'awayGoals'] } })), '1');
  assert.equal(await value(proofRule({ reader: { value: { sum: ['homeGoals', 'awayGoals'] }, scale: 1 }, decision: { type: 'number', operator: 'lt', value: '1' } })), '0.3');
  const ready: any = evaluateSettlement(rule, [capture], { now: T0 + 6 * 3600 });
  assert.equal(ready.status, 'ready'); assert.equal(ready.outcome, 2); assert.equal(ready.packet.measuredValue, 'HOME_TEAM');
  assert.equal(verifySettlementPacket(ready.packet, { packetHash: ready.packetHash, expectedRuleHash: ready.ruleHash }).status, 'ready');
});

test('an unpinned signer or too few signers is refused', async () => {
  const rule = proofRule();
  assert.equal(await why(rule, { keys: [OTHER_KEY] }), 'PROOF_SIGNATURE_INVALID');
  const pair = proofRule({ reader: { attestors: [ATTESTOR, OTHER], minSignatures: 2 } });
  assert.equal(await why(pair), 'PROOF_SIGNATURE_INVALID');
  assert.equal(await why(pair, { keys: [ATTESTOR_KEY, ATTESTOR_KEY] }), 'PROOF_SIGNATURE_INVALID');
  assert.equal(await value(pair, { keys: [ATTESTOR_KEY, OTHER_KEY] }), 'HOME_TEAM');
});

test('any edited signed field breaks the claim', async () => {
  const rule = proofRule(), capture = await proofCapture(rule);
  const edited = withBody(capture, body => {
    const context = JSON.parse(body.proof.claimData.context);
    context.extractedParameters.winner = 'AWAY_TEAM';
    body.proof.claimData.context = JSON.stringify(context);
  });
  assert.equal(reason(() => read(rule, edited)), 'PROOF_IDENTIFIER_MISMATCH');
});

test('a proof made for another rule is refused', async () => {
  const rule = proofRule();
  for (const options of [{ ruleHash: 'ff'.repeat(32) }, { context: { contextAddress: '0x' + '1'.repeat(40) } }, { context: { reclaimSessionId: 'session-1' } }])
    assert.equal(await why(rule, options), 'PROOF_CONTEXT_MISMATCH', JSON.stringify(options));
});

test('the proven request must equal the committed request', async () => {
  const rule = proofRule();
  const variants: Record<string, (p: any) => void> = {
    'another url': p => { p.url = 'https://api.example.org/v4/matches/124'; },
    'another method': p => { p.method = 'POST'; },
    'extra header': p => { p.headers = { ...p.headers, 'x-extra': '1' }; },
    'changed regex': p => { p.responseMatches = [{ ...p.responseMatches[0], value: '"id":(?<matchId>[0-9]{1,13})' }, ...p.responseMatches.slice(1)]; },
    'missing redaction': p => { p.responseRedactions = p.responseRedactions.slice(1); },
    geoLocation: p => { p.geoLocation = 'US'; },
    inverted: p => { p.responseMatches = [{ ...p.responseMatches[0], invert: true }, ...p.responseMatches.slice(1)]; },
    'filled paramValues': p => { p.paramValues = { a: 'b' }; },
    'unknown key': p => { p.secretValue = 'x'; },
    body: p => { p.body = '{}'; },
  };
  for (const [label, change] of Object.entries(variants))
    assert.equal(await why(rule, { parameters: params(rule, change) }), 'PROOF_REQUEST_MISMATCH', label);
  assert.equal(await value(rule, { parameters: params(rule, p => { p.geoLocation = ''; p.paramValues = {}; }) }), 'HOME_TEAM');
  assert.equal(await value(rule, { parameters: jcs(JSON.parse(params(rule))) }), 'HOME_TEAM');
});

test('identity and finality checks decide nothing until they hold', async () => {
  const rule = proofRule(), { winner, ...partial } = EXTRACTED;
  assert.equal(await why(rule, { extracted: { ...EXTRACTED, status: 'IN_PLAY' } }), 'OBSERVATION_IDENTITY_MISMATCH');
  assert.equal(await why(rule, { extracted: { ...EXTRACTED, matchId: '124' } }), 'OBSERVATION_IDENTITY_MISMATCH');
  assert.equal(await why(rule, { extracted: partial }), 'PROOF_PARAMETER_INVALID');
});

test('the signed time is the capture time and must be inside the window', async () => {
  const rule = proofRule(), later = T0 + 10 * 3600;
  assert.equal(await why(rule, { timestampS: T0 + 60, fetchedAt: T0 + 61 }, later), 'PROOF_TIME_MISMATCH');
  assert.equal(await why(rule, { timestampS: T0 - 1 }, later), 'PROOF_OUTSIDE_WINDOW');
  assert.equal(await why(rule, { timestampS: T0 + 6 * 3600 + 1 }, later), 'PROOF_OUTSIDE_WINDOW');
  assert.equal(await value(rule, { timestampS: T0 }, later), 'HOME_TEAM');
  assert.equal(await value(rule, { timestampS: T0 + 6 * 3600 }, later), 'HOME_TEAM');
});

test('only short declared fields may be revealed', async () => {
  const rule = proofRule();
  assert.equal(await why(rule, { extracted: { ...EXTRACTED, status: 'F'.repeat(201) } }), 'PROOF_PARAMETER_INVALID');
  assert.equal(await why(rule, { extracted: { ...EXTRACTED, email: 'a@b.example' } }), 'PROOF_PARAMETER_INVALID');
  assert.equal(await why(rule, { extracted: { ...EXTRACTED, status: '' } }), 'PROOF_PARAMETER_INVALID');
});

test('duplicate keys anywhere in the capture are refused', async () => {
  const rule = proofRule(), capture = await proofCapture(rule), schema = '"schema":"flurbo.proof-capture.v1"';
  const body = capture.body.replace(schema, `${schema},${schema}`);
  assert.equal(reason(() => read(rule, { ...capture, body, bytes: Buffer.byteLength(body), sha256: digest(body) })), 'EXTRACTION_DUPLICATE_FIELD');
  assert.equal(reason(() => read(rule, withBody(capture, b => { b.note = 'x'; }))), 'PROOF_CAPTURE_INVALID');
  assert.equal(reason(() => read(rule, { ...capture, contentType: 'text/html' })), 'CONTENT_TYPE_MISMATCH');
});

test('the earliest proof decides and two different proofs in one second conflict', async () => {
  const rule = proofRule(), at = (timestampS: number, winner: string) => proofCapture(rule, { timestampS, extracted: { ...EXTRACTED, winner } });
  const ready: any = evaluateSettlement(rule, [await at(T0 + 60, 'HOME_TEAM'), await at(T0 + 900, 'AWAY_TEAM')], { now: T0 + 6 * 3600 });
  assert.equal(ready.status, 'ready'); assert.equal(ready.outcome, 2);
  const conflict: any = evaluateSettlement(rule, [await at(T0 + 60, 'HOME_TEAM'), await at(T0 + 60, 'AWAY_TEAM')], { now: T0 + 6 * 3600 });
  assert.equal(conflict.status, 'unresolved'); assert.equal(conflict.reason, 'INITIAL_SOURCE_CONFLICT');
});

test('credentialed sources are never fetched directly', async () => {
  let calls = 0;
  await assert.rejects(retrieveSettlementCapture(proofRule(), MATCH_URL, { request: async () => { calls++; throw Error('network'); } }),
    (error: any) => error.reason === 'PROOF_CAPTURE_REQUIRED');
  assert.equal(calls, 0);
});

test('proof reader settings are validated before any market can use them', () => {
  const bad: [string, (rule: any) => void, RegExp][] = [
    ['initial vintage', rule => { rule.vintage = 'initial'; }, /first-observed-snapshot/],
    ['two urls', rule => { rule.source.urls = [MATCH_URL, MATCH_URL + '?x=1']; }, /one URL/],
    ['no checks', rule => { rule.source.reader.checks = []; }, /proof checks/],
    ['undeclared check', rule => { rule.source.reader.checks = [{ param: 'nope', equals: '1' }]; }, /proof checks/],
    ['regex without a group', rule => { rule.source.reader.responseMatches = [{ type: 'regex', value: '"id":[0-9]+' }]; }, /proof matches/],
    ['lookahead', rule => { rule.source.reader.responseMatches[0].value = '"id":(?=1)(?<matchId>[0-9]{1,12})'; }, /proof matches/],
    ['backreference', rule => { rule.source.reader.responseMatches[0].value = '(?<matchId>[0-9])\\1'; }, /proof matches/],
    ['repeated group name', rule => { rule.source.reader.responseMatches[1].value = '"status":"(?<matchId>[A-Z_]{1,20})"'; }, /proof matches/],
    ['uppercase attestor', rule => { rule.source.reader.attestors = [ATTESTOR.toUpperCase().replace('0X', '0x')]; }, /proof attestors/],
    ['too many signatures', rule => { rule.source.reader.minSignatures = 2; }, /proof attestors/],
    ['authorization header', rule => { rule.source.reader.request.headers.authorization = 'x'; }, /proof request/],
    ['credential header repeated', rule => { rule.source.reader.request.headers['x-auth-token'] = 'x'; }, /proof request/],
    ['xPath redaction', rule => { rule.source.reader.responseRedactions[0] = { xPath: '//id' }; }, /proof redactions/],
    ['hashed redaction', rule => { rule.source.reader.responseRedactions[0] = { jsonPath: '$.id', hash: 'oprf' }; }, /proof redactions/],
    ['contains match', rule => { rule.source.reader.responseMatches[0] = { type: 'contains', value: '"id"' }; }, /proof matches/],
    ['sum of a category', rule => { rule.source.reader.value = { sum: ['homeGoals', 'awayGoals'] }; }, /proof value/],
    ['cookie with a name', rule => { rule.source.reader.credential = { kind: 'cookie', name: 'session', label: 'football-data' }; }, /proof credential/],
    ['unknown reader key', rule => { rule.source.reader.extra = true; }, /proof reader/],
    ['other proof type', rule => { rule.source.reader.proof = 'other'; }, /proof reader/],
  ];
  assert.doesNotThrow(() => validateSettlementRule(proofRule()));
  for (const [label, change, message] of bad) {
    const rule = proofRule(); change(rule);
    assert.throws(() => validateSettlementRule(rule), message, label);
  }
  assert.doesNotThrow(() => validateSettlementRule(proofRule({ reader: { credential: { kind: 'cookie', label: 'session-form' } } })));
});

test('authoring needs a six-hour proof window', () => {
  const window = (hours: number) => proofRule({ timing: { publicationCutoff: T0 + hours * 3600, correctionCutoff: T0 + hours * 3600, observationEndsAt: T0 + hours * 3600 } });
  const issues = settlementRuleAuthoringIssues(window(2));
  assert.equal(issues.length, 1); assert.match(issues[0], /at least 6 hours/);
  assert.deepEqual(settlementRuleAuthoringIssues(window(6)), []);
});

test('the rule check accepts a sample proof made before the window', async () => {
  const rule = proofRule(), now = T0 - 7200, proof = await proofCapture(rule, { timestampS: T0 - 7300 });
  const valid = await checkRule(rule, { now, proofs: [proof] });
  assert.equal(valid.status, 'ok'); assert.equal(valid.sources[0].result, 'proof-valid');
  assert.equal(valid.sources[0].value, 'HOME_TEAM'); assert.deepEqual(valid.sources[0].signers, [ATTESTOR]);
  assert.equal(valid.ruleHash, settlementRuleHash(rule));
  const none = await checkRule(rule, { now });
  assert.equal(none.status, 'ok'); assert.equal(none.sources[0].result, 'proof-required');
  const forged = await checkRule(rule, { now, proofs: [await proofCapture(rule, { timestampS: T0 - 7300, keys: [OTHER_KEY] })] });
  assert.equal(forged.status, 'source-error'); assert.equal(forged.sources[0].result, 'proof-invalid');
  assert.equal(forged.sources[0].reason, 'PROOF_SIGNATURE_INVALID');
});

async function replayFixture(t: any) {
  const directory = await mkdtemp(join(tmpdir(), 'flurbo-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rule = proofRule(), ready: any = evaluateSettlement(rule, [await proofCapture(rule)], { now: T0 + 6 * 3600 });
  assert.equal(ready.status, 'ready');
  const write = async (name: string, value: unknown) => { const path = join(directory, name); await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value)); return path; };
  return { rule, ready, ruleHash: ready.ruleHash as string, write };
}

test('a proof packet replays from a file with no credentials', async t => {
  const { ready, ruleHash, write } = await replayFixture(t);
  const verified = await verifyEvidence(await write('packet.json', ready.packet), { ruleHash });
  assert.deepEqual(verified, { status: 'verified', outcome: 2, measuredValue: 'HOME_TEAM', selectedRecordId: ready.packet.selectedRecordId,
    adapter: 'proof-http.v1', signers: [ATTESTOR] });
  const attachment = JSON.stringify({ packet: ready.packet, packetHash: ready.packetHash });
  const body = { schema: 'flurbo.pilot-evidence.v1', eventId: 'fd-123-home-win', outcome: 2, attachment };
  assert.equal((await verifyEvidence(await write('evidence.json', body), { ruleHash })).outcome, 2);
  const reference = JSON.stringify({ schema: 'flurbo.settlement-packet-reference.v1', ruleHash, packetHash: ready.packetHash, packetURI: 'https://flurbopm.singu.online/api/settlement/packets/' + ready.packetHash });
  const served = async (url: string) => ({ status: 200, redirected: false, url, headers: new Headers({ 'content-type': 'application/json' }), body: (async function* () { yield Buffer.from(canonical(ready.packet)); })() });
  assert.equal((await verifyEvidence(await write('reference.json', { ...body, attachment: reference }), { ruleHash, request: served as any })).status, 'verified');
  assert.equal((await verifyEvidence('https://flurbopm.singu.online/api/settlement/packets/' + ready.packetHash, { ruleHash, request: served as any })).signers?.[0], ATTESTOR);
});

test('replay refuses a packet that was changed, a different rule and unsupported input', async t => {
  const { ready, ruleHash, write } = await replayFixture(t);
  const why = async (input: string, options: any = { ruleHash }) => { try { await verifyEvidence(input, options); } catch (error: any) { return error.reason ?? error.message; } return 'no error'; };
  const edited = structuredClone(ready.packet); edited.measuredValue = 'AWAY_TEAM';
  assert.equal(await why(await write('edited.json', edited)), 'PACKET_REPLAY_FAILED');
  const claimed = JSON.stringify({ packet: edited, packetHash: ready.packetHash });
  assert.equal(await why(await write('claimed.json', { schema: 'flurbo.pilot-evidence.v1', attachment: claimed })), 'PACKET_BINDING_FAILED');
  assert.equal(await why(await write('packet.json', ready.packet), { ruleHash: 'ee'.repeat(32) }), 'PACKET_BINDING_FAILED');
  assert.equal(await why(await write('other.json', { schema: 'something-else' })), 'EVIDENCE_FORMAT_UNSUPPORTED');
  assert.equal(await why(await write('broken.json', '{not json')), 'EVIDENCE_FORMAT_UNSUPPORTED');
  const wrongHash = JSON.stringify({ packet: ready.packet, packetHash: 'ab'.repeat(32) });
  assert.equal(await why(await write('hash.json', { schema: 'flurbo.pilot-evidence.v1', attachment: wrongHash })), 'PACKET_BINDING_FAILED');
  assert.equal(await why('http://insecure.example/packet.json'), 'EVIDENCE_FORMAT_UNSUPPORTED');
});

test('the replay command prints one JSON line and a matching exit code', async t => {
  const { ready, ruleHash, write } = await replayFixture(t), path = await write('packet.json', ready.packet);
  const script = fileURLToPath(new URL('../scripts/verify-settlement-evidence.mjs', import.meta.url));
  const good = await promisify(execFile)(process.execPath, [script, path, '--rule-hash', ruleHash]);
  assert.equal(JSON.parse(good.stdout).status, 'verified');
  const bad: any = await promisify(execFile)(process.execPath, [script, path, '--rule-hash', 'ee'.repeat(32)]).catch(error => error);
  assert.equal(bad.code, 1); assert.deepEqual(JSON.parse(bad.stdout), { status: 'failed', reason: 'PACKET_BINDING_FAILED' });
  const usage: any = await promisify(execFile)(process.execPath, [script]).catch(error => error);
  assert.equal(usage.code, 1);
});

const genuine = new URL('./fixtures/settlement/proof-football-data.json', import.meta.url);
test('a genuine Reclaim proof verifies offline', { skip: !existsSync(genuine) && 'record the fixture first (Phase E of the universal readers plan)' }, () => {
  const { rule, capture } = JSON.parse(readFileSync(genuine, 'utf8'));
  const inspected = inspectProofCapture(rule, capture);
  const recorded = JSON.parse(JSON.parse(capture.body).proof.claimData.context).extractedParameters;
  assert.ok(Object.values(recorded).includes(inspected.value));
  assert.ok(inspected.signers.every((signer: string) => rule.source.reader.attestors.includes(signer)));
  assert.ok(inspected.signers.length >= rule.source.reader.minSignatures);
  const edited = withBody(capture, body => {
    const context = JSON.parse(body.proof.claimData.context);
    context.providerHash = context.providerHash.replace(/.$/, (digit: string) => (digit === '0' ? '1' : '0'));
    body.proof.claimData.context = JSON.stringify(context);
  });
  assert.equal(reason(() => inspectProofCapture(rule, edited)), 'PROOF_IDENTIFIER_MISMATCH');
});
