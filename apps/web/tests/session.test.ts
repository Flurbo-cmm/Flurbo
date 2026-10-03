import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { privateKeyToAccount } from 'viem/accounts';
import { SessionStore, LOGIN_MS } from '../server/session.mjs';
import { localApi } from '../server/local-api.mjs';
import { AuthController } from '../src/auth/controller.ts';
import { authPolicy, SESSION_MS } from '../src/auth/policy.ts';

// Public, unfunded fixture used only for proof verification.
const signer = privateKeyToAccount('0x' + '11'.repeat(32));
const origin = 'http://localhost:18767';
test('server proofs are one-use, origin-bound, expiring and revocable', async () => {
  let now = Date.now(); const store = new SessionStore(() => now);
  const challenge = store.challenge(signer.address, origin);
  const signature = await signer.signMessage({ message: challenge.message });
  const login = await store.verify(challenge.id, signature, origin);
  assert.equal(store.read(login.sessionId, origin)?.address, signer.address.toLowerCase());
  assert.equal(store.read(login.sessionId, 'http://127.0.0.1:18767'), null);
  await assert.rejects(store.verify(challenge.id, signature, origin));
  const wrongOrigin = store.challenge(signer.address, origin);
  await assert.rejects(store.verify(wrongOrigin.id, await signer.signMessage({ message: wrongOrigin.message }), 'https://attacker.example'));
  const stale = store.challenge(signer.address, origin); now += 300001;
  await assert.rejects(store.verify(stale.id, await signer.signMessage({ message: stale.message }), origin));
  store.revoke(login.sessionId); assert.equal(store.read(login.sessionId, origin), null);
  const next = store.challenge(signer.address, origin);
  const nextLogin = await store.verify(next.id, await signer.signMessage({ message: next.message }), origin);
  now += LOGIN_MS; assert.equal(store.read(nextLogin.sessionId, origin), null);
});

test('HTTP login sets an HttpOnly cookie, restores, rejects cross-origin writes, and logs out', async () => {
  const hosts: string[] = [];
  const middleware = localApi({hosts});
  const server = createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as {port:number}).port;
  hosts.push(`127.0.0.1:${port}`);
  const request = (path: string, body?: object, cookie = '', requestOrigin = `http://127.0.0.1:${port}`) => fetch(`http://127.0.0.1:${port}/api/${path}`, {
    method: body ? 'POST' : 'GET', headers: { Origin: requestOrigin, 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined,
  });
  try {
    assert.equal((await request('auth/challenge', {address:signer.address}, '', 'https://evil.example')).status, 403);
    const challenge = await request('auth/challenge', {address:signer.address});
    const challengeCookie = challenge.headers.getSetCookie()[0].split(';')[0];
    const {message} = await challenge.json();
    const verified = await request('auth/verify', {signature: await signer.signMessage({message})}, challengeCookie);
    assert.equal(verified.status, 200);
    const cookies = verified.headers.getSetCookie();
    assert.match(cookies[0], /HttpOnly; SameSite=Strict; Path=\/api; Max-Age=604800/);
    const sessionCookie = cookies[0].split(';')[0];
    assert.equal((await (await request('auth/session', undefined, sessionCookie)).json()).session.address, signer.address.toLowerCase());
    assert.equal((await request('rpc', {method:'anvil_setBalance',params:[]})).status,400);
    assert.equal((await request('rpc', {method:'eth_sendRawTransaction',params:['0x01']})).status,401);
    const originalFetch = globalThis.fetch;
    const pool = '0x' + '22'.repeat(20), cash = '0x' + '33'.repeat(20);
    let broadcasts = 0;
    globalThis.fetch = async (input, options) => {
      if (input === 'http://127.0.0.1:18765/api/state') return Response.json({environment:'local_fork',contracts:{pool,cash}});
      if (input === 'http://127.0.0.1:18545') { broadcasts++; return Response.json({result:'0x'+'77'.repeat(32)}); }
      return originalFetch(input,options);
    };
    try {
      const transaction = {type:'legacy' as const,chainId:10143,nonce:0,gas:100000n,gasPrice:1000000000n,to:cash as `0x${string}`,value:0n,data:('0x095ea7b3'+pool.slice(2).padStart(64,'0')+'1'.padStart(64,'0')) as `0x${string}`};
      const valid = await signer.signTransaction(transaction);
      assert.equal((await request('rpc',{method:'eth_sendRawTransaction',params:[valid]},sessionCookie)).status,403);
      const foreign = await signer.signTransaction({...transaction,chainId:1});
      assert.equal((await request('rpc',{method:'eth_sendRawTransaction',params:[foreign]},sessionCookie)).status,403);
      const transfer = await signer.signTransaction({...transaction,value:1n});
      assert.equal((await request('rpc',{method:'eth_sendRawTransaction',params:[transfer]},sessionCookie)).status,403);
      assert.equal(broadcasts,0);
    } finally { globalThis.fetch = originalFetch; }
    await request('auth/logout',{},sessionCookie);
    assert.equal((await (await request('auth/session',undefined,sessionCookie)).json()).session,null);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('reload restores a verified account without a Mera transaction signer', async () => {
  let now = Date.now(), login: {address:string;expiresAt:number}|null = null;
  const store = new SessionStore(() => now); let challengeId = '';
  const transport = {
    async read() { return login; },
    async challenge(address:string) { const c = store.challenge(address,origin); challengeId=c.id; return c.message; },
    async verify(signature:string) { const result=await store.verify(challengeId,signature,origin); login={address:result.address,expiresAt:result.expiresAt}; return login; },
    async logout() { login=null; },
  };
  const policy = authPolicy(origin,true,true,true);
  const client = { async createCredential() { return {credentialId:new Uint8Array([1]),prfEnabled:true,prfOutput:new Uint8Array(32).fill(9)}; }, async getCredential() { return {credentialId:new Uint8Array([1]),prfOutput:new Uint8Array(32).fill(9)}; } };
  const first = new AuthController({policy,client,transport,now:()=>now});
  const reloaded = new AuthController({policy,client,transport,now:()=>now});
  try {
    assert.equal(await first.authenticate('login'),true);
    const account=first.getSnapshot().address;
    assert.equal(first.getSnapshot().expiresAt,now+LOGIN_MS);
    now += SESSION_MS; first.checkExpiry();
    assert.equal(first.getSnapshot().address,account);
    assert.equal(first.getSnapshot().signingExpiresAt,null);
    await reloaded.restore(); assert.equal(reloaded.getSnapshot().address?.toLowerCase(),account?.toLowerCase());
    await assert.rejects(reloaded.signDigest('0x'+'00'.repeat(32)), /account access only/);
    assert.equal(await reloaded.authenticate('login'),true);
    assert.equal(reloaded.getSnapshot().signingExpiresAt,null);
    await reloaded.signOut(); await first.restore(); assert.equal(first.getSnapshot().address,null);
  } finally { await first.signOut(); await reloaded.signOut(); }
});

test('stale restoration cannot finish the loading gate or reopen a signed-out account', async () => {
  type Login = {address:string; expiresAt:number} | null;
  const pending: Array<(value:Login) => void> = [];
  const transport = { read: () => new Promise<Login>(resolve => pending.push(resolve)),
    async challenge() { throw new Error('unused'); }, async verify() { throw new Error('unused'); }, async logout() {} };
  const controller = new AuthController({policy:authPolicy(origin,true,true,true),transport});
  const login = {address:signer.address,expiresAt:Date.now()+LOGIN_MS};
  const first = controller.restore();
  controller.lockSigning(); // React StrictMode cleanup invalidates the first mount.
  const second = controller.restore();
  pending[0](null); await first;
  assert.equal(controller.getSnapshot().restoring,true);
  assert.equal(controller.getSnapshot().address,null);
  pending[1](login); await second;
  assert.equal(controller.getSnapshot().restoring,false);
  assert.equal(controller.getSnapshot().address,signer.address);
  const late = controller.restore();
  await controller.signOut(); pending[2](login); await late;
  assert.equal(controller.getSnapshot().address,null);
  assert.equal(controller.getSnapshot().restoring,false);
});
