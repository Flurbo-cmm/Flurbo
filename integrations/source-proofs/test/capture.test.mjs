import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { createSignDataForClaim, getIdentifierFromClaimInfo, recoverSignersOfSignedClaim } from '@reclaimprotocol/js-sdk';
import { PROOF_CONTEXT_ADDRESS, proofContextMessage, reclaimIdentifier, recoverPersonalSigner } from '../../../apps/web/server/source-proof.mjs';
import { settlementRuleHash } from '../../../apps/web/server/settlement-rules.mjs';
import { parseSettlementCapture } from '../../../apps/web/server/settlement-evidence.mjs';
import { createProofCapture, credentialEnvName, proofRequest, proveForRule, submitProofCapture } from '../capture.mjs';
import { T0, TOKEN, fakeClient, rule, wallet } from './proof-helpers.mjs';

test('the web verifier matches the Reclaim SDK', async () => {
  const parameters = '{"body":"","method":"GET","responseMatches":[{"type":"regex","value":"\\"status\\":\\"(?<status>[A-Z_]{1,20})\\""}],"responseRedactions":[{"jsonPath":"$.status"}],"url":"https://api.example.org/v1/items/42"}';
  const message = 'flurbo.proof-context.v1:' + 'ab'.repeat(32), zero = '0x' + '0'.repeat(40), providerHash = '0x' + '12'.repeat(32);
  const contexts = [
    `{"contextMessage":"${message}","contextAddress":"${zero}","extractedParameters":{"status":"FINISHED"},"providerHash":"${providerHash}"}`,
    `{"providerHash":"${providerHash}","extractedParameters":{"b":"2","a":"1","\\u00e9":"caf\\u00e9"},"contextAddress":"${zero}","contextMessage":"${message}"}`,
    `{"extractedParameters":{"z":"quote \\" and slash \\\\ and \\u2028 and \\ud83d\\ude00"},"contextMessage":"${message}","contextAddress":"${zero}","providerHash":"${providerHash}"}`,
  ];
  for (const context of contexts) {
    const claim = { provider: 'http', parameters, owner: wallet.address.toLowerCase(), timestampS: T0, context, epoch: 1 };
    assert.equal(reclaimIdentifier(claim), getIdentifierFromClaimInfo(claim));
    const signature = await wallet.signMessage(createSignDataForClaim(claim));
    const [signer] = recoverSignersOfSignedClaim({ claim, signatures: [ethers.getBytes(signature)] });
    assert.equal(recoverPersonalSigner(createSignDataForClaim(claim), signature), signer);
    assert.equal(signer, wallet.address.toLowerCase());
  }
});

test('the capture request carries the credential only in secret options', async () => {
  assert.equal(credentialEnvName('football-data'), 'FLURBO_PROOF_CREDENTIAL_FOOTBALL_DATA');
  const calls = [], header = rule(), ruleHash = settlementRuleHash(header);
  await createProofCapture({ rule: header, credential: TOKEN, appId: 'app-1', appSecret: 'secret-1', clientClass: fakeClient(calls) });
  assert.equal(calls.length, 1);
  const { publicOptions, secretOptions } = calls[0];
  assert.deepEqual(publicOptions, { method: 'GET', headers: { accept: 'application/json' },
    context: { contextAddress: PROOF_CONTEXT_ADDRESS, contextMessage: proofContextMessage(ruleHash) }, useTee: false });
  assert.equal(JSON.stringify(publicOptions).includes(TOKEN), false);
  assert.equal(calls[0].url, header.source.urls[0]);
  assert.equal(secretOptions.headers['X-Auth-Token'], TOKEN);
  assert.deepEqual(secretOptions.responseMatches, header.source.reader.responseMatches);
  assert.deepEqual(secretOptions.responseRedactions, header.source.reader.responseRedactions);
  const cookie = rule({ kind: 'cookie', label: 'session-form' }), request = proofRequest(cookie, settlementRuleHash(cookie), TOKEN);
  assert.equal(request.secretOptions.cookieStr, TOKEN); assert.equal(request.secretOptions.headers, undefined);
  assert.equal(JSON.stringify(request.publicOptions).includes(TOKEN), false);
  assert.equal(proofRequest(header, ruleHash, TOKEN, 'tee').publicOptions.useTee, true);
  const post = rule(); post.source.reader.request = { method: 'POST', body: '{"id":123}' };
  assert.equal(proofRequest(post, ruleHash, TOKEN).publicOptions.body, '{"id":123}');
  assert.equal('body' in proofRequest(header, ruleHash, TOKEN).publicOptions, false);
  await assert.rejects(createProofCapture({ rule: header, credential: TOKEN, appId: 'a', appSecret: 's', clientClass: class { async zkFetch() { return null; } } }), /No proof produced/);
  const wrong = rule(); wrong.source.adapter = 'json-api.v1';
  await assert.rejects(createProofCapture({ rule: wrong, credential: TOKEN, appId: 'a', appSecret: 's', clientClass: fakeClient([]) }));
});

test('the capture verifies with the settlement reader', async () => {
  const subject = rule(), proof = await new (fakeClient([]))('a', 's').zkFetch(subject.source.urls[0],
    { method: 'GET', headers: { accept: 'application/json' }, context: { contextAddress: PROOF_CONTEXT_ADDRESS, contextMessage: proofContextMessage(settlementRuleHash(subject)) } },
    { responseMatches: subject.source.reader.responseMatches, responseRedactions: subject.source.reader.responseRedactions });
  const capture = await createProofCapture({ rule: subject, credential: TOKEN, appId: 'a', appSecret: 's', clientClass: fakeClient([]) });
  assert.equal(parseSettlementCapture(subject, capture, T0 + 120).value, 'HOME_TEAM');
  assert.equal(capture.fetchedAt, proof.claimData.timestampS);
  assert.equal(capture.body.includes('extractedParameterValues'), false);
  assert.equal(capture.body.includes(TOKEN), false);
  assert.deepEqual(Object.keys(JSON.parse(capture.body)), ['schema', 'proof']);
  assert.deepEqual(Object.keys(JSON.parse(capture.body).proof.claimData).sort(), ['context', 'epoch', 'identifier', 'owner', 'parameters', 'provider', 'timestampS']);
  const proved = await proveForRule({ rule: subject, credential: TOKEN, appId: 'a', appSecret: 's', now: T0 + 120, clientClass: fakeClient([]) });
  assert.equal(proved.value, 'HOME_TEAM'); assert.equal(proved.ruleHash, settlementRuleHash(subject)); assert.deepEqual(proved.signers, [wallet.address.toLowerCase()]);
  const early = await proveForRule({ rule: subject, credential: TOKEN, appId: 'a', appSecret: 's', now: T0 - 5000, window: false, clientClass: fakeClient([], { timestampS: T0 - 5100 }) });
  assert.equal(early.value, 'HOME_TEAM');
  await assert.rejects(proveForRule({ rule: subject, credential: TOKEN, appId: 'a', appSecret: 's', now: T0 + 120,
    clientClass: fakeClient([], { timestampS: T0 + 900 }) }), error => error.reason === 'CAPTURE_TIME_INVALID');
});

test('the prover refuses to run outside the capture window', async () => {
  const calls = [], subject = rule();
  for (const now of [T0 - 1, T0 + 6 * 3600 + 1])
    await assert.rejects(proveForRule({ rule: subject, credential: TOKEN, appId: 'a', appSecret: 's', now, mode: 'zk', clientClass: fakeClient(calls) }), /Outside the capture window/);
  assert.equal(calls.length, 0);
});

test('submission posts the rule hash and capture with a bearer token', async () => {
  const subject = rule(), ruleHash = settlementRuleHash(subject), seen = [];
  const capture = await createProofCapture({ rule: subject, credential: TOKEN, appId: 'a', appSecret: 's', clientClass: fakeClient([]) });
  const reply = (status, body) => async (url, init) => { seen.push({ url, init }); return { status, json: async () => body }; };
  const stored = { status: 'stored', ruleHash, firstFetchedAt: capture.fetchedAt, latestFetchedAt: capture.fetchedAt };
  const result = await submitProofCapture({ origin: 'https://flurbopm.singu.online', token: 'bearer-token-1234567890123456789012345', ruleHash, capture, request: reply(200, stored) });
  assert.deepEqual(result, stored);
  const [{ url, init }] = seen;
  assert.equal(url, 'https://flurbopm.singu.online/api/settlement/proof-captures');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, 'Bearer bearer-token-1234567890123456789012345');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.deepEqual(Object.keys(JSON.parse(init.body)), ['ruleHash', 'capture']);
  await assert.rejects(submitProofCapture({ origin: 'https://flurbopm.singu.online', token: 'x'.repeat(40), ruleHash, capture,
    request: reply(422, { error: 'Proof capture rejected', reason: 'PROOF_SIGNATURE_INVALID' }) }), /Proof submission rejected: 422 PROOF_SIGNATURE_INVALID/);
  await assert.rejects(submitProofCapture({ origin: 'https://flurbopm.singu.online', token: 'x'.repeat(40), ruleHash, capture,
    request: reply(401, { error: 'Proof submission unauthorized' }) }), /Proof submission rejected: 401 Proof submission unauthorized/);
  await assert.rejects(submitProofCapture({ origin: 'http://flurbopm.singu.online', token: 'x'.repeat(40), ruleHash, capture, request: reply(200, stored) }), /origin/i);
});
