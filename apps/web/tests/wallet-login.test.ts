import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { SessionStore, digest } from '../server/session.mjs';
import { RedisSessionStore } from '../server/redis-session.mjs';
import { AuthController } from '../src/auth/controller.ts';
import { authPolicy } from '../src/auth/policy.ts';
const signer = privateKeyToAccount(('0x' + '11'.repeat(32)) as `0x${string}`);
const origin = 'https://flurbo.singu.online';
test('wallet login cannot be requested and legacy wallet proofs and sessions are rejected', async () => {
  const store = new SessionStore();
  assert.throws(() => store.challenge(signer.address, origin, 'wallet'));
  const challenge = store.challenge(signer.address, origin);
  store.challenges.get(digest(challenge.id)).method = 'wallet';
  await assert.rejects(store.verify(challenge.id, await signer.signMessage({ message: challenge.message }), origin));
  const legacy = { address: signer.address, expiresAt: Date.now() + 60000, origin, method: 'wallet' };
  store.sessions.set(digest('legacy'), legacy);
  assert.equal(store.read('legacy', origin), null);
  const durable = new RedisSessionStore(async () => JSON.stringify(legacy));
  assert.equal(await durable.read('legacy', origin), null);
  const controller = new AuthController({ policy: authPolicy(origin, false, true, true), transport: {
    async read() { return {...legacy, method:'wallet' as const}; },
    async challenge() { throw Error('unused'); }, async verify() { throw Error('unused'); }, async logout() {},
  } });
  await controller.restore();
  assert.equal(controller.getSnapshot().address, null);
  assert.equal('authenticateWallet' in controller, false);
});
