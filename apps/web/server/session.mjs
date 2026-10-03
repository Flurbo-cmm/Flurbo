import { randomBytes, createHash } from 'node:crypto';
import { verifyMessage } from 'viem';

export const LOGIN_MS = 7 * 24 * 60 * 60 * 1000;
const token = () => randomBytes(32).toString('base64url');
export const digest = value => createHash('sha256').update(value).digest('hex');
export const cookieValue = (header, name) => (header || '').split(';').map(x => x.trim()).find(x => x.startsWith(name + '='))?.slice(name.length + 1);

// Development uses memory; the hosted adapter uses an external expiring store.
export class SessionStore {
  challenges = new Map();
  sessions = new Map();
  constructor(now = Date.now) { this.now = now; }
  prune() {
    for (const map of [this.challenges, this.sessions]) for (const [key, value] of map) if (value.expiresAt <= this.now()) map.delete(key);
  }
  challenge(address, origin, method = 'passkey') {
    this.prune();
    if (method !== 'passkey' || !/^0x[0-9a-fA-F]{40}$/.test(address) || this.challenges.size >= 1000) throw new Error('Invalid or busy login request');
    const id = token(), expiresAt = this.now() + 5 * 60_000;
    const message = `Flurbo account login\nOrigin: ${origin}\nAddress: ${address.toLowerCase()}\nNonce: ${token()}\nExpires: ${new Date(expiresAt).toISOString()}\nThis signature opens a seven-day account session. It does not authorize a transaction.`;
    this.challenges.set(digest(id), { address: address.toLowerCase(), origin, message, expiresAt, method });
    return { id, message };
  }
  async verify(id, signature, origin) {
    this.prune();
    const key = digest(id || ''), challenge = this.challenges.get(key);
    this.challenges.delete(key); // One attempt, including rejected signatures.
    if (!challenge || challenge.method !== 'passkey' || challenge.origin !== origin || !/^0x[0-9a-fA-F]{130}$/.test(signature || '') ||
        !await verifyMessage({ address: challenge.address, message: challenge.message, signature })) throw new Error('Login proof rejected');
    if (this.sessions.size >= 1000) throw new Error('Session capacity reached');
    const session = { address: challenge.address, origin, expiresAt: this.now() + LOGIN_MS, method: challenge.method || 'passkey' }, sessionId = token();
    this.sessions.set(digest(sessionId), session);
    return { sessionId, ...session };
  }
  read(id, origin) { this.prune(); const value = this.sessions.get(digest(id || '')); return value?.origin === origin && value.method === 'passkey' ? value : null; }
  revoke(id) { this.sessions.delete(digest(id || '')); }
}
