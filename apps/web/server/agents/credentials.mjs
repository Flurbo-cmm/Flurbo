import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SCOPES } from '../../../../packages/sdk/src/protocol.ts';

// Agent API credentials (protocol/specs/auth.md). The token is returned once at issuance; only the
// SHA-256 digest of its secret is stored. A credential reads and reports; it never signs.
export const TOKEN = /^fla1_([0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;
export const DEFAULT_TTL_DAYS = 30, MAX_TTL_DAYS = 90;
const sha256 = value => createHash('sha256').update(value).digest();

export class RuntimeError extends Error {
  constructor(status, code, message, retryAfter = null) { super(message); this.status = status; this.code = code; this.retryAfter = retryAfter; }
}

export function newCredential({ account, scopes, ttlDays = DEFAULT_TTL_DAYS, label = '', now }) {
  if (!Array.isArray(scopes) || scopes.length < 1 || scopes.some(s => !SCOPES.includes(s)) || new Set(scopes).size !== scopes.length)
    throw new RuntimeError(400, 'INVALID_INPUT', 'Choose at least one supported scope.');
  if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > MAX_TTL_DAYS) throw new RuntimeError(400, 'INVALID_INPUT', `Expiry must be 1 to ${MAX_TTL_DAYS} days.`);
  if (typeof label !== 'string' || label.length > 48 || /[\u0000-\u001f\u007f]/.test(label)) throw new RuntimeError(400, 'INVALID_INPUT', 'Use a label of at most 48 characters.');
  const credentialId = randomBytes(8).toString('hex'), secret = randomBytes(32).toString('base64url');
  return {
    token: `fla1_${credentialId}_${secret}`,
    record: { schema: 'flurbo.agent-credential.v1', credentialId, secretSha256: sha256(secret).toString('hex'), account: account.toLowerCase(),
      scopes: [...scopes].sort(), label: label.trim(), createdAt: now, expiresAt: now + ttlDays * 86_400, revokedAt: null, lastUsedAt: null },
  };
}

export const credentialStatus = (r, now) => (r.revokedAt ? 'revoked' : r.expiresAt <= now ? 'expired' : 'active');
// What the dashboard may show. Never the secret or its digest.
export const publicCredential = (r, now) => ({ credentialId: r.credentialId, label: r.label, scopes: r.scopes, createdAt: r.createdAt, expiresAt: r.expiresAt,
  revokedAt: r.revokedAt, lastUsedAt: r.lastUsedAt, status: credentialStatus(r, now), preview: `fla1_${r.credentialId}_...` });

// Resolves an Authorization header to a live credential record, or throws a RuntimeError. The same
// generic error covers malformed, unknown and wrong-secret tokens.
export async function authenticate(store, header, now) {
  const match = typeof header === 'string' && /^Bearer [^\s]+$/.test(header) ? TOKEN.exec(header.slice(7)) : null;
  const unauthenticated = () => new RuntimeError(401, 'UNAUTHENTICATED', 'A valid agent credential is required.');
  if (!match) throw unauthenticated();
  const record = await store.credential(match[1]);
  if (!record) throw unauthenticated();
  const expected = Buffer.from(record.secretSha256, 'hex'), given = sha256(match[2]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw unauthenticated();
  if (record.revokedAt) throw new RuntimeError(401, 'CREDENTIAL_REVOKED', 'This agent credential was revoked.');
  if (record.expiresAt <= now) throw new RuntimeError(401, 'CREDENTIAL_EXPIRED', 'This agent credential has expired.');
  return record;
}
