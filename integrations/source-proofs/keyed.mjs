import { getHashFromProof, getHttpProviderClaimParamsFromProof, verifyProof } from '@reclaimprotocol/js-sdk';
import { ReclaimClient } from '@reclaimprotocol/zk-fetch';
import { validateBinding } from './browser.mjs';

const FULL_JSON_REGEX = '(?<data>[\\s\\S]*)';
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const cleanUrl = value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && url.href === value;
  } catch { return false; }
};
const pathValue = (data, path) => path.split('.').reduce((value, key) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value[key] : undefined, data);

export async function createKeyedProof({ appId, appSecret, url, headerName, token, binding,
  clientClass = ReclaimClient, now = Date.now() }) {
  validateBinding(binding);
  if (binding.sourceKind !== 'keyed-api' || !text(appId) || !text(appSecret) || !text(token)
    || !cleanUrl(url) || !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(headerName)
    || !text(binding.recordPath) || !/^[A-Za-z][A-Za-z0-9_.]*$/.test(binding.recordPath)
    || !/^[A-Za-z][A-Za-z0-9_.]*$/.test(binding.field)) throw Error('Invalid keyed proof request');
  const client = new clientClass(appId, appSecret);
  const contextMessage = JSON.stringify(binding);
  const proof = await client.zkFetch(url,
    { method: 'GET', useTee: true, headers: { accept: 'application/json' },
      context: { contextAddress: binding.nonce, contextMessage } },
    { headers: { [headerName]: token }, responseMatches: [{ type: 'regex', value: FULL_JSON_REGEX }] });
  if (!proof) throw Error('No keyed proof produced');
  return { proof, session: { schema: 'flurbo.keyed-proof-session.v1', appId, sessionId: binding.nonce,
    binding, contextMessage, url, matchRegex: FULL_JSON_REGEX, createdAt: now, expiresAt: now + 15 * 60_000 } };
}

export async function verifyKeyedProof({ proof, session, appSecret, consumeSession, now = Date.now(),
  verifier = verifyProof, paramsFromProof = getHttpProviderClaimParamsFromProof, hashesFromProof = getHashFromProof }) {
  if (!proof || !session || session.schema !== 'flurbo.keyed-proof-session.v1'
    || !validateBinding(session.binding) || session.binding.sourceKind !== 'keyed-api'
    || !text(session.sessionId) || session.sessionId !== session.binding.nonce || !text(session.contextMessage)
    || session.contextMessage !== JSON.stringify(session.binding) || !cleanUrl(session.url)
    || session.matchRegex !== FULL_JSON_REGEX || !text(appSecret) || typeof consumeSession !== 'function'
    || !Number.isSafeInteger(session.createdAt) || !Number.isSafeInteger(session.expiresAt)
    || now < session.createdAt || now > session.expiresAt) throw Error('Invalid or expired keyed proof session');
  const params = paramsFromProof(proof);
  if (params.url !== session.url || params.method !== 'GET' || (params.body !== null && params.body !== undefined && params.body !== '')
    || !Array.isArray(params.responseMatches) || params.responseMatches.length !== 1
    || params.responseMatches[0].type !== 'regex' || params.responseMatches[0].value !== session.matchRegex
    || params.responseMatches[0].invert === true || params.responseMatches[0].isOptional === true
    || !Array.isArray(params.responseRedactions) || params.responseRedactions.length !== 0)
    throw Error('Keyed proof request differs from committed source');
  const hashes = hashesFromProof(proof);
  if (!Array.isArray(hashes) || hashes.length !== 1 || !/^0x[0-9a-fA-F]{64}$/.test(hashes[0]))
    throw Error('Invalid keyed proof content hash');
  const result = await verifier(proof, { hashes, teeAttestation: { appSecret } });
  if (!result.isVerified || result.isTeeAttestationVerified !== true || result.data?.length !== 1)
    throw Error('Keyed proof verification failed');
  const { context, extractedParameters } = result.data[0];
  if (context?.contextAddress !== session.binding.nonce
    || context.contextMessage !== session.contextMessage || typeof extractedParameters?.data !== 'string')
    throw Error('Keyed proof does not match initiated market session');
  const stamp = Number(proof.claimData?.timestampS);
  if (!Number.isSafeInteger(stamp) || stamp * 1000 < session.createdAt - 60_000
    || stamp * 1000 > session.expiresAt + 60_000) throw Error('Keyed proof timestamp is outside session');
  let response;
  try { response = JSON.parse(extractedParameters.data); } catch { throw Error('Keyed proof response is not JSON'); }
  if (String(pathValue(response, session.binding.recordPath)) !== session.binding.recordId)
    throw Error('Keyed proof record differs from committed source');
  const value = pathValue(response, session.binding.field);
  if (typeof value !== 'number' && typeof value !== 'string') throw Error('Keyed proof field is missing');
  if (session.binding.statusField && pathValue(response, session.binding.statusField) !== session.binding.finalStatus)
    throw Error('Keyed proof record is not final');
  if (!await consumeSession(session.sessionId)) throw Error('Keyed proof session already accepted');
  return { binding: session.binding, value: String(value), proofIdentifier: proof.identifier };
}
