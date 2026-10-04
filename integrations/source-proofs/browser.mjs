import { ReclaimProofRequest, verifyProof } from '@reclaimprotocol/js-sdk';

const text = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const hex32 = value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);

export function validateBinding(binding) {
  if (!binding || binding.schema !== 'flurbo.private-source.v1' || binding.chainId !== 10143
    || !/^0x[0-9a-fA-F]{40}$/.test(binding.pool) || !hex32(binding.rulesHash)
    || !hex32(binding.eventHash) || !Number.isInteger(binding.eventIndex)
    || binding.eventIndex < 0 || binding.eventIndex > 31
    || !['login-page', 'keyed-api'].includes(binding.sourceKind)
    || !text(binding.field) || !text(binding.recordId) || !/^0x[0-9a-fA-F]{32,64}$/.test(binding.nonce)
    || (binding.sourceKind === 'login-page' && !text(binding.recordField))) {
    throw Error('Invalid private-source binding');
  }
  return binding;
}

export async function createBrowserRequest({ appId, appSecret, providerId, callbackUrl, binding, now = Date.now(), requestClass = ReclaimProofRequest }) {
  validateBinding(binding);
  if (binding.sourceKind !== 'login-page' || !text(appId) || !text(appSecret) || !text(providerId)
    || !callbackUrl?.startsWith('https://')) throw Error('Invalid browser proof request');
  const request = await requestClass.init(appId, appSecret, providerId);
  const sessionId = request.getSessionId();
  if (!text(sessionId)) throw Error('Missing Reclaim session');
  const contextMessage = JSON.stringify(binding);
  request.setContext(sessionId, contextMessage);
  request.setAppCallbackUrl(callbackUrl, true);
  const version = request.getProviderVersion();
  if (version.providerId !== providerId || !text(version.providerVersion)) throw Error('Missing provider version');
  return { requestJson: request.toJsonString(),
    session: { schema: 'flurbo.proof-session.v1', appId, sessionId, providerId,
      providerVersion: version.providerVersion, contextMessage, binding, createdAt: now, expiresAt: now + 15 * 60_000 } };
}

export async function verifyBrowserProof({ proofs, session, appSecret, consumeSession, now = Date.now(), verifier = verifyProof }) {
  if (!session || session.schema !== 'flurbo.proof-session.v1' || !validateBinding(session.binding)
    || session.binding.sourceKind !== 'login-page' || !text(session.sessionId)
    || !text(session.providerId) || !text(session.providerVersion) || !text(appSecret)
    || typeof consumeSession !== 'function' || !Number.isSafeInteger(session.createdAt)
    || !Number.isSafeInteger(session.expiresAt) || now < session.createdAt || now > session.expiresAt
    || !Array.isArray(proofs) || proofs.length !== 1) throw Error('Invalid or expired proof session');
  const config = { providerId: session.providerId, providerVersion: session.providerVersion,
    teeAttestation: { appSecret } };
  const result = await verifier(proofs, config);
  if (!result.isVerified || result.isTeeAttestationVerified !== true || result.data?.length !== 1)
    throw Error('Reclaim proof verification failed');
  const { context, extractedParameters } = result.data[0];
  if (context?.reclaimSessionId !== session.sessionId
    || (context.contextAddress ?? context.address) !== session.sessionId
    || (context.contextMessage ?? context.message) !== session.contextMessage
    || session.contextMessage !== JSON.stringify(session.binding)
    || !extractedParameters || typeof extractedParameters[session.binding.field] !== 'string') {
    throw Error('Proof does not match the initiated market session');
  }
  if (extractedParameters[session.binding.recordField] !== session.binding.recordId) {
    throw Error('Proof record differs from committed source');
  }
  const stamp = Number(proofs[0].claimData?.timestampS);
  if (!Number.isSafeInteger(stamp) || stamp * 1000 < session.createdAt - 60_000
    || stamp * 1000 > session.expiresAt + 60_000) throw Error('Proof timestamp is outside session');
  if (!await consumeSession(session.sessionId)) throw Error('Proof session already accepted');
  return { binding: session.binding, value: extractedParameters[session.binding.field],
    proofIdentifier: proofs[0].identifier, providerId: session.providerId,
    providerVersion: session.providerVersion };
}
