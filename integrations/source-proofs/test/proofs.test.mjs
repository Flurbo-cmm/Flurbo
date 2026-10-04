import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserRequest, verifyBrowserProof } from '../browser.mjs';
import { createKeyedProof, verifyKeyedProof } from '../keyed.mjs';
import { decideIntegerProof } from '../decision.mjs';

const binding = {
  schema: 'flurbo.private-source.v1', chainId: 10143,
  pool: '0x' + '1'.repeat(40), rulesHash: '0x' + '2'.repeat(64),
  eventHash: '0x' + '3'.repeat(64), eventIndex: 31,
  sourceKind: 'login-page', field: 'responseCount', recordField: 'formId',
  recordId: 'form-id-example', nonce: '0x' + 'a'.repeat(32),
};

class FakeRequest {
  static async init() { return new FakeRequest(); }
  getSessionId() { return 'test-session'; }
  getProviderVersion() { return { providerId: 'provider-1', providerVersion: '1.0.0' }; }
  setContext(address, message) { this.context = { address, message }; }
  setAppCallbackUrl(url) { this.callbackUrl = url; }
  toJsonString() { return JSON.stringify({ context: this.context, callbackUrl: this.callbackUrl }); }
}

test('browser proof is bound to exact market, provider and one session', async () => {
  const { session, requestJson } = await createBrowserRequest({
    appId: 'app-1', appSecret: 'secret', providerId: 'provider-1',
    callbackUrl: 'https://example.org/proof', binding, now: 1000, requestClass: FakeRequest,
  });
  assert.match(requestJson, /test-session/);
  const proofs = [{ identifier: 'proof-1', claimData: { timestampS: 2 } }];
  const verify = async (_proofs, config) => {
    assert.deepEqual(config, { providerId: 'provider-1', providerVersion: '1.0.0',
      teeAttestation: { appSecret: 'secret' } });
    return { isVerified: true, isTeeAttestationVerified: true,
      data: [{ context: { reclaimSessionId: session.sessionId, contextAddress: session.sessionId,
        contextMessage: session.contextMessage }, extractedParameters: { responseCount: '42', formId: binding.recordId } }] };
  };
  const accepted = new Set();
  const consumeSession = async id => { if (accepted.has(id)) return false; accepted.add(id); return true; };
  const args = { proofs, session, appSecret: 'secret', consumeSession, now: 2000, verifier: verify };
  assert.equal((await verifyBrowserProof(args)).value, '42');
  await assert.rejects(verifyBrowserProof(args), /already accepted/);
  await assert.rejects(verifyBrowserProof({ ...args, now: 1_000_000 }), /expired/);
  await assert.rejects(verifyBrowserProof({ ...args, verifier: async () => ({ isVerified: false }) }), /verification failed/);
  await assert.rejects(verifyBrowserProof({ ...args, verifier: async () => ({ isVerified: true,
    isTeeAttestationVerified: true, data: [{ context: { reclaimSessionId: 'other' },
      extractedParameters: { responseCount: '42', formId: binding.recordId } }] }) }), /does not match/);
});

test('keyed API proof hides token from public request parameters', async () => {
  let observed;
  class FakeClient {
    constructor(appId, appSecret) { this.sessionId = 'keyed-session'; assert.equal(appId, 'app-1'); assert.equal(appSecret, 'secret'); }
    async zkFetch(url, publicOptions, privateOptions) {
      observed = { url, publicOptions, privateOptions };
      return { identifier: 'proof-2' };
    }
  }
  const { proof, session } = await createKeyedProof({
    appId: 'app-1', appSecret: 'secret', url: 'https://api.football-data.org/v4/matches/1',
    headerName: 'X-Auth-Token', token: 'private-token',     binding: { ...binding, sourceKind: 'keyed-api', field: 'score.fullTime.home', recordPath: 'id', statusField: 'status', finalStatus: 'FINISHED' },
    clientClass: FakeClient,
  });
  assert.equal(proof.identifier, 'proof-2');
  assert.equal(session.sessionId, binding.nonce);
  assert.equal(observed.publicOptions.context.contextAddress, binding.nonce);
  assert.equal(observed.privateOptions.headers['X-Auth-Token'], 'private-token');
  assert.equal(JSON.stringify(observed.publicOptions).includes('private-token'), false);
});

test('a verified integer is interpreted only under its committed field rule', () => {
  const verified = { binding, value: '42' };
  const rule = { schema: 'flurbo.private-decision.v1', field: 'responseCount', operator: 'gte', threshold: '40' };
  assert.equal(decideIntegerProof(verified, rule), 2);
  assert.equal(decideIntegerProof(verified, { ...rule, threshold: '43' }), 1);
  assert.throws(() => decideIntegerProof({ ...verified, value: 'missing' }, rule), /Invalid/);
  assert.throws(() => decideIntegerProof(verified, { ...rule, field: 'other' }), /Invalid/);
});
test('keyed verifier binds exact request, signed response, record and session', async () => {
  const keyedBinding = { ...binding, sourceKind: 'keyed-api', field: 'score.fullTime.home',
    recordPath: 'id', recordId: '123', statusField: 'status', finalStatus: 'FINISHED' };
  const session = { schema: 'flurbo.keyed-proof-session.v1', appId: 'app-1', sessionId: keyedBinding.nonce,
    binding: keyedBinding, contextMessage: JSON.stringify(keyedBinding),
    url: 'https://api.football-data.org/v4/matches/123', matchRegex: '(?<data>[\\s\\S]*)', createdAt: 1000, expiresAt: 10_000 };
  const proof = { identifier: 'proof-3', claimData: { timestampS: 2 } };
  const params = { url: session.url, method: 'GET', body: '', responseMatches: [
    { type: 'regex', value: session.matchRegex } ], responseRedactions: [] };
  const verified = { isVerified: true, isTeeAttestationVerified: true, data: [{
    context: { contextAddress: keyedBinding.nonce,
      contextMessage: session.contextMessage },
    extractedParameters: { data: JSON.stringify({ id: 123, status: 'FINISHED', score: { fullTime: { home: 2 } } }) },
  }] };
  const consumed = new Set();
  const args = { proof, session, appSecret: 'secret', now: 2000,
    paramsFromProof: () => params, hashesFromProof: () => ['0x' + '4'.repeat(64)],
    verifier: async (_proof, config) => { assert.equal(config.teeAttestation.appSecret, 'secret'); return verified; },
    consumeSession: async id => { if (consumed.has(id)) return false; consumed.add(id); return true; } };
  assert.equal((await verifyKeyedProof(args)).value, '2');
  await assert.rejects(verifyKeyedProof(args), /already accepted/);
  await assert.rejects(verifyKeyedProof({ ...args, paramsFromProof: () => ({ ...params, url: 'https://other.example/match' }) }), /differs/);
  await assert.rejects(verifyKeyedProof({ ...args, verifier: async () => ({ ...verified, data: [{
    ...verified.data[0], extractedParameters: { data: JSON.stringify({ id: 123, status: 'LIVE', score: { fullTime: { home: 2 } } }) },
  }] }) }), /not final/);
});