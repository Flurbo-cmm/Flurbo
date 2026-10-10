import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hashMessage, hexToBytes, keccak256, stringToBytes } from 'viem';

// Offline verifier for Reclaim HTTPS claims. It never touches the network and never needs an application secret:
// the identifier is recomputed from the signed fields, signers are recovered with a synchronous EIP-191 recovery,
// and the caller pins the attestor addresses it trusts. Nothing here imports another server module, so settlement
// readers can load it in the CRE bundle.
export const PROOF_CONTEXT_PREFIX = 'flurbo.proof-context.v1:';
export const PROOF_CONTEXT_ADDRESS = '0x0000000000000000000000000000000000000000';

const MAX_FIELD = 20_000;
const CLAIM_KEYS = ['provider', 'parameters', 'owner', 'timestampS', 'context', 'identifier', 'epoch'];
const issue = reason => { throw Object.assign(Error(reason), { reason }); };
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const positive = value => Number.isSafeInteger(value) && value > 0;

export function proofContextMessage(ruleHash) {
  if (typeof ruleHash !== 'string' || !/^[0-9a-f]{64}$/.test(ruleHash)) throw Error('Invalid rule hash');
  return PROOF_CONTEXT_PREFIX + ruleHash;
}

// RFC 8785 for the only shapes a claim context holds. Keys sort by UTF-16 code unit, which is the default order.
export function jcs(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  if (plainObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${jcs(value[key])}`).join(',')}}`;
  return issue('PROOF_CONTEXT_INVALID');
}

// Strict reader for contexts: objects, arrays and strings only, no repeated keys.
function parseStringTree(input) {
  const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
  let i = 0;
  const fail = () => issue('PROOF_CONTEXT_INVALID');
  const space = () => { while (i < input.length && ' \n\r\t'.includes(input[i])) i++; };
  const string = () => { STRING.lastIndex = i; const match = STRING.exec(input); if (!match) fail(); i = STRING.lastIndex; return JSON.parse(match[0]); };
  const value = depth => {
    if (depth > 16) fail();
    space();
    if (input[i] === '"') return string();
    if (input[i] === '[') {
      i++; const list = []; space();
      if (input[i] === ']') { i++; return list; }
      for (;;) { list.push(value(depth + 1)); space(); if (input[i] === ',') { i++; continue; } if (input[i] === ']') { i++; return list; } fail(); }
    }
    if (input[i] !== '{') return fail();
    i++; const object = Object.create(null); space();
    if (input[i] === '}') { i++; return object; }
    for (;;) {
      space(); if (input[i] !== '"') fail();
      const key = string();
      if (Object.hasOwn(object, key)) fail();
      space(); if (input[i++] !== ':') fail();
      object[key] = value(depth + 1); space();
      if (input[i] === ',') { i++; continue; }
      if (input[i] === '}') { i++; return object; }
      fail();
    }
  };
  const result = value(0); space();
  if (i !== input.length) fail();
  return result;
}

export function reclaimIdentifier({ provider, parameters, context }) {
  if (typeof provider !== 'string' || typeof parameters !== 'string' || typeof context !== 'string') issue('PROOF_CLAIM_INVALID');
  const canonicalContext = context === '' ? '' : jcs(parseStringTree(context));
  return keccak256(stringToBytes(`${provider}\n${parameters}\n${canonicalContext}`));
}

export function reclaimSignData({ identifier, owner, timestampS, epoch }) {
  return `${identifier}\n${owner.toLowerCase()}\n${timestampS}\n${epoch}`;
}

export function recoverPersonalSigner(message, signature) {
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) issue('PROOF_SIGNATURE_INVALID');
  const bytes = hexToBytes(signature), v = bytes[64];
  const recovery = v === 27 || v === 28 ? v - 27 : v === 0 || v === 1 ? v : issue('PROOF_SIGNATURE_INVALID');
  try {
    const key = secp256k1.recoverPublicKey(Uint8Array.of(recovery, ...bytes.slice(0, 64)), hexToBytes(hashMessage(message)), { prehash: false });
    return '0x' + keccak256(secp256k1.Point.fromBytes(key).toBytes(false).slice(1)).slice(-40);
  } catch { return issue('PROOF_SIGNATURE_INVALID'); }
}

function inspect(proof) {
  if (!plainObject(proof) || !plainObject(proof.claimData)) issue('PROOF_CLAIM_INVALID');
  const claim = proof.claimData, keys = Object.keys(claim);
  if (keys.length !== CLAIM_KEYS.length || !CLAIM_KEYS.every(key => keys.includes(key))) issue('PROOF_CLAIM_INVALID');
  if (![claim.provider, claim.parameters, claim.context].every(field => typeof field === 'string' && field.length <= MAX_FIELD)
    || typeof claim.identifier !== 'string' || typeof proof.identifier !== 'string' || typeof claim.owner !== 'string'
    || !/^0x[0-9a-fA-F]{40}$/.test(claim.owner) || !positive(claim.timestampS) || !positive(claim.epoch)
    || !Array.isArray(proof.signatures) || !proof.signatures.length || proof.signatures.length > 8
    || !proof.signatures.every(signature => typeof signature === 'string' && /^0x[0-9a-fA-F]{130}$/.test(signature))) issue('PROOF_CLAIM_INVALID');
  const identifier = reclaimIdentifier(claim);
  const context = claim.context === '' ? {} : JSON.parse(claim.context);
  if (claim.identifier !== identifier || proof.identifier !== identifier) issue('PROOF_IDENTIFIER_MISMATCH');
  const message = reclaimSignData(claim);
  return { claim, context, signers: [...new Set(proof.signatures.map(signature => recoverPersonalSigner(message, signature)))] };
}

export function recoverClaimSigners(proof) { return inspect(proof).signers; }

export function verifyReclaimClaim(proof, { attestors, minSignatures }) {
  if (!Array.isArray(attestors) || !Number.isSafeInteger(minSignatures) || minSignatures < 1) issue('PROOF_SIGNATURE_INVALID');
  const { claim, context, signers } = inspect(proof);
  const pinned = signers.filter(signer => attestors.some(attestor => attestor.toLowerCase() === signer));
  if (pinned.length < minSignatures) issue('PROOF_SIGNATURE_INVALID');
  if (!plainObject(context)) issue('PROOF_CONTEXT_INVALID');
  return { identifier: claim.identifier, owner: claim.owner, timestampS: claim.timestampS, epoch: claim.epoch, provider: claim.provider,
    parameters: claim.parameters, context, extracted: context.extractedParameters ?? {}, signers: pinned };
}
