import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { PROOF_CONTEXT_ADDRESS, PROOF_CONTEXT_PREFIX, reclaimIdentifier, reclaimSignData, recoverClaimSigners,
  recoverPersonalSigner, verifyReclaimClaim } from '../server/source-proof.mjs';

const KEYS = [11, 22, 33].map(n => `0x${String(n).repeat(32)}` as const);
const [ONE, TWO, THREE] = KEYS.map(key => privateKeyToAccount(key));
const PARAMETERS = '{"body":"","method":"GET","responseMatches":[{"type":"regex","value":"\\"status\\":\\"(?<status>[A-Z_]{1,20})\\""}],"responseRedactions":[{"jsonPath":"$.status"}],"url":"https://api.example.org/v1/items/42"}';
const context = () => JSON.stringify({ contextMessage: PROOF_CONTEXT_PREFIX + 'ab'.repeat(32), contextAddress: PROOF_CONTEXT_ADDRESS,
  extractedParameters: { status: 'FINISHED' }, providerHash: '0x' + '12'.repeat(32) });
const reason = (fn: () => unknown) => { try { fn(); } catch (e: any) { return e.reason ?? e.message; } return 'no error'; };

async function signedProof(keys: readonly `0x${string}`[], over: any = {}) {
  const claimData: any = { provider: 'http', parameters: PARAMETERS, owner: '0x' + 'cd'.repeat(20), timestampS: 1_791_000_060, context: context(), epoch: 1, ...over };
  claimData.identifier = reclaimIdentifier(claimData);
  const message = reclaimSignData(claimData);
  const signatures = await Promise.all(keys.map(key => privateKeyToAccount(key).signMessage({ message })));
  return { identifier: claimData.identifier, claimData, signatures };
}

test('the claim identifier and signed text follow the published format', () => {
  const identifier = reclaimIdentifier({ provider: 'http', parameters: PARAMETERS, context: context() });
  assert.equal(identifier, '0x6fa37f4f718b9e1ee8890f5a129591d7ef7686a1e3930e3a158354b0efc48843');
  assert.equal(reclaimIdentifier({ provider: 'http', parameters: PARAMETERS, context: '' }) === identifier, false);
  assert.equal(reclaimSignData({ identifier, owner: '0x' + 'CD'.repeat(20), timestampS: 1_791_000_000, epoch: 1 }),
    `${identifier}\n0x${'cd'.repeat(20)}\n1791000000\n1`);
});

test('personal signatures recover synchronously', async () => {
  const message = 'flurbo\nsigned text';
  for (const key of KEYS) {
    const account = privateKeyToAccount(key);
    assert.equal(recoverPersonalSigner(message, await account.signMessage({ message })), account.address.toLowerCase());
  }
  assert.equal(recoverPersonalSigner(message, await TWO.signMessage({ message })), '0x1563915e194d8cfba1943570603f7606a3115508');
  const signature = await ONE.signMessage({ message }), base = signature.slice(0, 130);
  assert.equal(recoverPersonalSigner(message, `${base}${signature.endsWith('1c') ? '01' : '00'}`), ONE.address.toLowerCase());
});

test('malformed signatures and contexts are refused', async () => {
  const message = 'flurbo', signature = await ONE.signMessage({ message });
  assert.equal(reason(() => recoverPersonalSigner(message, signature.slice(0, 2 + 128))), 'PROOF_SIGNATURE_INVALID');
  assert.equal(reason(() => recoverPersonalSigner(message, `${signature.slice(0, 130)}1d`)), 'PROOF_SIGNATURE_INVALID');
  assert.equal(reason(() => recoverPersonalSigner(message, 'not a signature')), 'PROOF_SIGNATURE_INVALID');
  assert.equal(reason(() => recoverPersonalSigner(message, `0x${'00'.repeat(65)}`)), 'PROOF_SIGNATURE_INVALID');
  assert.equal(reason(() => reclaimIdentifier({ provider: 'http', parameters: PARAMETERS, context: '{"a":1}' })), 'PROOF_CONTEXT_INVALID');
  assert.equal(reason(() => reclaimIdentifier({ provider: 'http', parameters: PARAMETERS, context: 'not json' })), 'PROOF_CONTEXT_INVALID');
  assert.equal(reason(() => reclaimIdentifier({ provider: 'http', parameters: PARAMETERS, context: '{"a":"x","a":"y"}' })), 'PROOF_CONTEXT_INVALID');
});

test('pinned signers are counted once each', async () => {
  const pinned = [ONE.address.toLowerCase(), TWO.address.toLowerCase()];
  const twice = await signedProof([KEYS[0], KEYS[0]]);
  assert.equal(reason(() => verifyReclaimClaim(twice, { attestors: pinned, minSignatures: 2 })), 'PROOF_SIGNATURE_INVALID');
  assert.equal(verifyReclaimClaim(twice, { attestors: pinned, minSignatures: 1 }).signers.length, 1);
  const both = await signedProof([KEYS[0], KEYS[1]]);
  const verified = verifyReclaimClaim(both, { attestors: pinned, minSignatures: 2 });
  assert.equal(verified.signers.length, 2);
  assert.deepEqual(verified.extracted, { status: 'FINISHED' });
  assert.equal(verified.timestampS, 1_791_000_060);
  assert.equal(verified.provider, 'http');
  assert.equal(verified.parameters, PARAMETERS);
  const stranger = await signedProof([KEYS[2]]);
  assert.equal(reason(() => verifyReclaimClaim(stranger, { attestors: pinned, minSignatures: 1 })), 'PROOF_SIGNATURE_INVALID');
  assert.equal(THREE.address.toLowerCase() === pinned[0], false);
  const late = structuredClone(both); late.claimData.timestampS += 1;
  assert.equal(reason(() => verifyReclaimClaim(late, { attestors: pinned, minSignatures: 1 })), 'PROOF_SIGNATURE_INVALID');
  const edited = structuredClone(both); edited.claimData.parameters = PARAMETERS.replace('items/42', 'items/43');
  assert.equal(reason(() => verifyReclaimClaim(edited, { attestors: pinned, minSignatures: 1 })), 'PROOF_IDENTIFIER_MISMATCH');
  const split = structuredClone(both); split.identifier = split.identifier.replace(/.$/, c => (c === '0' ? '1' : '0'));
  assert.equal(reason(() => verifyReclaimClaim(split, { attestors: pinned, minSignatures: 1 })), 'PROOF_IDENTIFIER_MISMATCH');
  assert.deepEqual(recoverClaimSigners(both).sort(), [...pinned].sort());
});

test('claim shape problems are refused before any signature counts', async () => {
  const pinned = [ONE.address.toLowerCase()], good = await signedProof([KEYS[0]]);
  const claim = (change: (copy: any) => void) => { const copy = structuredClone(good); change(copy); return copy; };
  const verify = (proof: any) => reason(() => verifyReclaimClaim(proof, { attestors: pinned, minSignatures: 1 }));
  assert.equal(verify(claim(c => { c.claimData.extra = 'x'; })), 'PROOF_CLAIM_INVALID');
  assert.equal(verify(claim(c => { c.claimData.owner = '0x1234'; })), 'PROOF_CLAIM_INVALID');
  assert.equal(verify(claim(c => { c.claimData.timestampS = 1.5; })), 'PROOF_CLAIM_INVALID');
  assert.equal(verify(claim(c => { c.claimData.epoch = 0; })), 'PROOF_CLAIM_INVALID');
  assert.equal(verify(claim(c => { c.signatures = []; })), 'PROOF_CLAIM_INVALID');
  assert.equal(verify(claim(c => { c.signatures = ['0x12']; })), 'PROOF_CLAIM_INVALID');
  assert.equal(verify(claim(c => { c.claimData.parameters = 'x'.repeat(20_001); })), 'PROOF_CLAIM_INVALID');
  assert.equal(verify(null), 'PROOF_CLAIM_INVALID');
  assert.equal(verify({ ...good, claimData: undefined }), 'PROOF_CLAIM_INVALID');
});
