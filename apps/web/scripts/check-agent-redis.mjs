import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { redisCommand } from '../server/redis-session.mjs';
import { agentStore, redisBackend, ownershipKey, agentWalletKey, credentialKey, credentialUsedKey } from '../server/agents/agent-store.mjs';

// Validates the agent store's Redis operations (SET NX PX locks, the Lua scripts, MGET, SET EX, GETDEL)
// against a real Redis-compatible service before hosted rollout: agent state and transaction ownership,
// agent wallet claims, single-use expiring wallet challenges and credential records. Run it only against a
// test database or namespace:
//   FLURBO_AGENT_REDIS_CHECK=1 UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... node scripts/check-agent-redis.mjs
// It writes only keys under flurbo:agents:v1: for a random throwaway account and random transaction
// hashes, never settlement-monitor, resolution or other keys, and deletes every key it wrote.
const PREFIX = 'flurbo:agents:v1:';
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function checkAgentRedis(command, log = () => {}) {
  const written = new Set(), results = [];
  const guarded = async (op, ...args) => {
    const keys = op === 'EVAL' ? args.slice(2, 2 + Number(args[1])) : op === 'MGET' ? args : ['SET', 'GET', 'DEL', 'TTL', 'EXISTS', 'GETDEL'].includes(op) ? [args[0]] : null;
    if (!keys) throw new Error(`Unexpected command ${op}`);
    for (const key of keys) if (typeof key !== 'string' || !key.startsWith(PREFIX)) throw new Error('Refusing a key outside the agent namespace');
    if (op === 'SET' || op === 'EVAL') keys.forEach(k => written.add(k));
    return command(op, ...args);
  };
  const check = async (name, fn) => {
    try { await fn(); results.push([name, true]); log(`PASS ${name}`); }
    catch (e) { results.push([name, false]); log(`FAIL ${name}: ${e.message}`); }
  };
  const ok = (value, message) => { if (!value) throw new Error(message); };
  const account = '0x' + randomBytes(20).toString('hex'), other = '0x' + randomBytes(20).toString('hex'), hash = () => '0x' + randomBytes(32).toString('hex');
  const address = () => '0x' + randomBytes(20).toString('hex'), challengeId = () => randomBytes(32).toString('base64url');
  const backend = redisBackend(guarded), store = agentStore(backend);
  try {
    const base = PREFIX + 'selfcheck:' + randomBytes(8).toString('hex');
    await check('lock is exclusive and released only by its token', async () => {
      const a = await backend.lock(base + ':lock', 5000), b = await backend.lock(base + ':lock', 5000);
      ok(a && !b, 'second lock was granted');
      await backend.unlock(base + ':lock', 'not-the-token'); ok(!await backend.lock(base + ':lock', 5000), 'wrong token released the lock');
      await backend.unlock(base + ':lock', a); const c = await backend.lock(base + ':lock', 5000); ok(c, 'lock not released'); await backend.unlock(base + ':lock', c);
    });
    await check('hourly counter increments and expires', async () => {
      ok(await backend.count(base + ':rate', 7200) === 1 && await backend.count(base + ':rate', 7200) === 2, 'count did not increment');
      const ttl = Number(await guarded('TTL', base + ':rate')); ok(ttl > 0 && ttl <= 7200, 'counter has no expiry');
    });
    const s = base + ':state', r = base + ':rev';
    await check('versioned read of missing keys', async () => { const [rev, value] = await backend.versioned(s, r); ok(rev === '0' && value === null, 'unexpected initial state'); });
    await check('compare-and-set saves once and refuses a stale revision', async () => {
      ok(await backend.save(s, r, '0', { n: 1 }) === 1, 'first save failed');
      ok(await backend.save(s, r, '0', { n: 2 }) === 0, 'stale save accepted');
      const [rev, value] = await backend.versioned(s, r); ok(rev === '1' && value.n === 1, 'state or revision wrong');
    });
    const h = hash(), key = ownershipKey(10143, h), mine = { owner: 'a', agentId: 'x', proposalId: 'p', transaction: 'd' };
    await check('ownership is written atomically with the state', async () => {
      ok(await backend.save(s, r, '1', { n: 2 }, [{ key, value: mine }]) === 1, 'ownership save failed');
      ok(JSON.stringify(await backend.get(key)) === JSON.stringify(mine), 'ownership not stored');
    });
    await check('conflicting ownership refuses the whole write', async () => {
      ok(await backend.save(s, r, '2', { n: 3 }, [{ key, value: { ...mine, proposalId: 'q' } }]) === -1, 'conflict not detected');
      const [rev, value] = await backend.versioned(s, r); ok(rev === '2' && value.n === 2, 'state changed despite conflict');
      ok((await backend.get(key)).proposalId === 'p', 'ownership overwritten');
    });
    await check('the same ownership again is accepted unchanged', async () => {
      ok(await backend.save(s, r, '2', { n: 3 }, [{ key, value: mine }]) === 1, 'idempotent save refused');
    });
    await check('concurrent ownership of one transaction: exactly one wins', async () => {
      const k2 = ownershipKey(10143, hash()), s2 = base + ':race', r2 = base + ':race-rev';
      const outcomes = await Promise.all(['one', 'two', 'three'].map((p, i) => backend.save(s2 + i, r2 + i, '0', { p }, [{ key: k2, value: { ...mine, proposalId: p } }])));
      ok(outcomes.filter(x => x === 1).length === 1 && outcomes.filter(x => x === -1).length === 2, `outcomes ${outcomes}`);
    });
    await check('store: create, mutate, archive, read back', async () => {
      const profile = await store.create(account, { name: 'Redis check', status: 'active' }), h3 = hash();
      await store.mutate(account, profile.id, (state, _p, own) => { state.proposals.push({ id: 'p1', status: 'confirmed', reviews: [], transactions: [] }); own.claim(h3, 'p1', 'd'); return true; });
      written.add(ownershipKey(10143, h3));
      ok((await backend.get(ownershipKey(10143, h3)))?.proposalId === 'p1', 'ownership not written by the store');
      ok(await store.archive(account, profile.id, 0), 'archive failed');
      const read = await store.get(account, profile.id);
      ok(read.profile.status === 'archived' && read.state.proposals[0].id === 'p1', 'archived agent not readable');
      ok((await store.listArchived(account)).length === 1 && (await store.list(account)).length === 0, 'indexes wrong');
    });

    // Agent wallets: exclusive across every account; released only by the holder.
    await check('wallet claim is exclusive and released only by its holder', async () => {
      const key = agentWalletKey(address()), a = { owner: 'a', agentId: 'x' }, b = { owner: 'b', agentId: 'y' };
      ok(await backend.claimKey(key, a) && await backend.claimKey(key, a), 'the holder could not claim again');
      ok(!await backend.claimKey(key, b), 'another holder claimed a held wallet');
      ok(!await backend.releaseKey(key, b), 'a non-holder released the wallet');
      ok(JSON.stringify(await backend.get(key)) === JSON.stringify(a), 'the claim changed');
      ok(await backend.releaseKey(key, a) && await backend.get(key) === null, 'the holder could not release');
      ok(await backend.claimKey(key, b), 'a released wallet could not be claimed');
    });
    await check('concurrent wallet claims: exactly one wins', async () => {
      const key = agentWalletKey(address()), holders = Array.from({ length: 8 }, (_, i) => ({ owner: 'o' + i, agentId: 'a' + i }));
      const won = await Promise.all(holders.map(h => backend.claimKey(key, h)));
      ok(won.filter(Boolean).length === 1, `${won.filter(Boolean).length} claims won`);
      ok(JSON.stringify(await backend.get(key)) === JSON.stringify(holders[won.indexOf(true)]), 'the stored holder is not the winner');
    });
    await check('wallet claim is refused atomically while the wallet is linked for manual trading', async () => {
      const key = agentWalletKey(address()), linked = base + ':manual-link', holder = { owner: 'a', agentId: 'x' };
      await backend.set(linked, 'account');
      ok(await backend.claimKeyUnless(key, holder, linked) === -1 && await backend.get(key) === null, 'claimed despite the manual link');
      await backend.del(linked);
      ok(await backend.claimKeyUnless(key, holder, linked) === 1, 'claim refused without a manual link');
      ok(await backend.claimKeyUnless(key, { owner: 'b', agentId: 'y' }, linked) === 0, 'a second holder claimed the wallet');
      const race = agentWalletKey(address()), outcomes = await Promise.all(Array.from({ length: 8 }, (_, i) => backend.claimKeyUnless(race, { owner: 'o' + i, agentId: 'a' + i }, linked)));
      ok(outcomes.filter(x => x === 1).length === 1 && outcomes.filter(x => x === 0).length === 7, `outcomes ${outcomes}`);
    });
    await check('store: two accounts associate one wallet at once; one wins; archiving frees it', async () => {
      const wallet = address(), mine = await store.create(account, { name: 'Wallet A', kind: 'runtime', status: 'active' });
      const theirs = await store.create(other, { name: 'Wallet B', kind: 'runtime', status: 'active' });
      const outcomes = await Promise.allSettled([store.associateWallet(account, mine.id, wallet, 1), store.associateWallet(other, theirs.id, wallet, 1)]);
      const losers = outcomes.filter(o => o.status === 'rejected');
      ok(losers.length === 1 && losers[0].reason?.code === 'WALLET_IN_USE', `outcomes ${outcomes.map(o => o.status)}`);
      const [winner, winnerAccount, loser, loserAccount] = outcomes[0].status === 'fulfilled' ? [mine, account, theirs, other] : [theirs, other, mine, account];
      ok((await backend.get(agentWalletKey(wallet)))?.agentId === winner.id, 'the wallet key names the wrong agent');
      ok(await store.archive(winnerAccount, winner.id, 2), 'archive failed');
      ok(await backend.get(agentWalletKey(wallet)) === null, 'archiving did not free the wallet');
      ok((await store.associateWallet(loserAccount, loser.id, wallet, 3))?.wallet === wallet, 'the freed wallet could not be associated');
    });
    // Wallet proof challenges: expiring, and consumed exactly once.
    await check('challenge expires and is single use', async () => {
      const id = challengeId(), key = PREFIX + 'wallet-challenge:' + id;
      written.add(key);
      await store.putChallenge(id, { wallet: '0x1' }, 300);
      const ttl = Number(await guarded('TTL', key)); ok(ttl > 0 && ttl <= 300, `challenge ttl ${ttl}`);
      ok((await store.takeChallenge(id))?.wallet === '0x1', 'challenge not returned');
      ok(await store.takeChallenge(id) === null, 'challenge returned twice');
      const late = challengeId();
      written.add(PREFIX + 'wallet-challenge:' + late);
      await store.putChallenge(late, { wallet: '0x2' }, 1);
      await sleep(2100);
      ok(await store.takeChallenge(late) === null, 'an expired challenge was returned');
    });
    await check('concurrent takes of one challenge: exactly one succeeds', async () => {
      const id = challengeId();
      written.add(PREFIX + 'wallet-challenge:' + id);
      await store.putChallenge(id, { wallet: '0x3' }, 300);
      const taken = await Promise.all(Array.from({ length: 8 }, () => store.takeChallenge(id)));
      ok(taken.filter(Boolean).length === 1, `${taken.filter(Boolean).length} takes succeeded`);
    });
    // Credentials: the record is written only under the account lock; last use is an atomic raise.
    const issue = async (agentId, at) => {
      const credentialId = randomBytes(8).toString('hex');
      await store.issueCredential(account, agentId, { schema: 'flurbo.agent-credential.v1', credentialId, secretSha256: randomBytes(32).toString('hex'), account,
        scopes: ['markets:read', 'runtime:report'], label: 'check', createdAt: at, expiresAt: at + 86_400, revokedAt: null, lastUsedAt: null }, at);
      return credentialId;
    };
    await check('credential: a late last-use write never restores a revoked credential', async () => {
      const agent = await store.create(account, { name: 'Credential check', kind: 'runtime', status: 'active' }), id = await issue(agent.id, 100);
      const stale = await store.credential(id);  // what a request read before the revocation
      await store.touchCredential(id, 110);
      ok((await store.revokeCredential(account, agent.id, id, 120))?.revokedAt === 120, 'revocation failed');
      await store.touchCredential(stale.credentialId, 115);  // the delayed request records its use late
      await store.touchCredential(id, 130);
      const after = await store.credential(id), raw = await backend.get(credentialKey(id));
      ok(after.revokedAt === 120 && raw.revokedAt === 120, 'revocation was reset');
      ok(JSON.stringify(raw.scopes) === JSON.stringify(stale.scopes) && raw.expiresAt === stale.expiresAt && raw.secretSha256 === stale.secretSha256, 'scopes, expiry or secret changed');
      ok(after.lastUsedAt === 130 && Number(await backend.get(credentialUsedKey(id))) === 130, 'last use is not the latest');
    });
    await check('credential: concurrent uses around revocation and rotation keep both', async () => {
      const agent = await store.create(account, { name: 'Credential race', kind: 'runtime', status: 'active' });
      const revoked = await issue(agent.id, 200), rotated = await issue(agent.id, 200);
      const uses = id => Array.from({ length: 10 }, (_, i) => store.touchCredential(id, 201 + i));
      await Promise.all([...uses(revoked), store.revokeCredential(account, agent.id, revoked, 205), ...uses(rotated),
        store.revokeCredential(account, agent.id, rotated, 205, r => ({ ...r, revokedAt: 205, rotatedTo: 'feedfacefeedface' }))]);
      await Promise.all([...uses(revoked), ...uses(rotated)]);
      const a = await backend.get(credentialKey(revoked)), b = await backend.get(credentialKey(rotated));
      ok(a.revokedAt === 205, 'revocation lost under concurrent use');
      ok(b.revokedAt === 205 && b.rotatedTo === 'feedfacefeedface', 'rotation lost under concurrent use');
      ok((await store.credential(revoked)).lastUsedAt === 210 && (await store.credential(rotated)).lastUsedAt === 210, 'last use not the maximum');
      ok((await store.credentials(account, agent.id)).length === 2, 'credential list wrong');
    });
  } finally {
    for (const key of written) await command('DEL', key);
    const left = [];
    for (const key of written) if (Number(await command('EXISTS', key))) left.push(key);
    results.push(['cleanup removes every key the check wrote', left.length === 0]);
    log(left.length ? `FAIL cleanup left ${left.length} key(s)` : `PASS cleanup removed all ${written.size} test keys`);
  }
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.env.FLURBO_AGENT_REDIS_CHECK !== '1') { console.error('Set FLURBO_AGENT_REDIS_CHECK=1 and point UPSTASH_REDIS_REST_URL/TOKEN at a test database.'); process.exit(2); }
  const results = await checkAgentRedis(redisCommand(process.env), line => console.log(line));
  process.exit(results.every(([, passed]) => passed) ? 0 : 1);
}
