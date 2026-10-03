import { SessionStore, LOGIN_MS, digest } from './session.mjs';

export function redisCommand(env = process.env, request = fetch) {
  const url = new URL(env.UPSTASH_REDIS_REST_URL || 'https://invalid.example');
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.upstash.io') || url.port || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || !env.UPSTASH_REDIS_REST_TOKEN) throw new Error('Configure Upstash REST credentials on the host');
  return async (...command) => {
    const response = await request(url.href, { method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command), signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error('Session storage unavailable');
    const payload = await response.json();
    if (payload.error || !Object.hasOwn(payload, 'result')) throw new Error('Session storage rejected request');
    return payload.result;
  };
}

// Session reads are cached in memory for a short time: a page makes about twenty API calls, and each would
// otherwise read the same session from Redis. Sign-out goes through revoke() on this store and drops the
// cached entry at once. With several server instances, a session signed out on another one stays usable here
// for at most cacheMs.
export class RedisSessionStore {
  constructor(command, now = Date.now, { cacheMs = 30_000 } = {}) { this.command = command; this.now = now; this.cacheMs = cacheMs; this.cache = new Map(); }
  key(kind, id) { return `flurbo:auth:v1:${kind}:${digest(id || '')}`; }
  async challenge(address, origin, method = 'passkey') {
    const temporary = new SessionStore(this.now);
    const challenge = temporary.challenge(address, origin, method);
    // Atomic global + address budgets, with expiration, shared across restarts.
    const script = "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n";
    for (const [key, limit] of [['global', 60], [address.toLowerCase(), 5]]) {
      if (await this.command('EVAL', script, 1, this.key('rate', key)) > limit) throw new Error('Login rate limit reached');
    }
    await this.command('SET', this.key('challenge', challenge.id), JSON.stringify(temporary.challenges.get(digest(challenge.id))), 'EX', 300);
    return challenge;
  }
  async verify(id, signature, origin) {
    // GETDEL consumes the challenge exactly once, even across concurrent hosts.
    const stored = await this.command('GETDEL', this.key('challenge', id));
    if (!stored) throw new Error('Login proof rejected');
    const temporary = new SessionStore(this.now);
    temporary.challenges.set(digest(id || ''), JSON.parse(stored));
    const session = await temporary.verify(id, signature, origin);
    await this.command('SET', this.key('session', session.sessionId), JSON.stringify(temporary.read(session.sessionId, origin)), 'EX', LOGIN_MS / 1000);
    return session;
  }
  async read(id, origin) {
    if (!id) return null;
    const key = this.key('session', id), cached = this.cache.get(key);
    let value;
    if (cached && cached.until > this.now()) value = cached.value;
    else {
      const stored = await this.command('GET', key);
      if (!stored) { this.cache.delete(key); return null; }
      value = JSON.parse(stored);
      if (this.cacheMs > 0) {
        if (this.cache.size >= 5000) for (const [k, v] of this.cache) if (v.until <= this.now() || this.cache.size >= 5000) this.cache.delete(k);
        this.cache.set(key, { value, until: this.now() + this.cacheMs });
      }
    }
    return value.method === 'passkey' && value.origin === origin && value.expiresAt > this.now() ? value : null;
  }
  async revoke(id) { if (id) { const key = this.key('session', id); this.cache.delete(key); await this.command('DEL', key); } }
}
