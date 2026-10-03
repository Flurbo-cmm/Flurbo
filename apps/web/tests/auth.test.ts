import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthController, deriveAccount } from "../src/auth/controller.ts";
import { authPolicy, PASSKEY_HOST, SESSION_MS } from "../src/auth/policy.ts";
import type { WebAuthnClient } from "@category-labs/mera";

const local = authPolicy("http://localhost:18767/signup", true, true, true);
const storageKey = "flurbo.passkey.v1:localhost";
function setup(options: { client?: Partial<WebAuthnClient>; initial?: string; now?: () => number; storageFails?: boolean } = {}) {
  const records = new Map<string, string>();
  if (options.initial) records.set(storageKey, options.initial);
  const calls: { create: WebAuthnClient.CreateCredentialRequest[]; get: WebAuthnClient.GetCredentialRequest[] } = { create: [], get: [] };
  const client: WebAuthnClient = {
    createCredential: async request => { calls.create.push(request); return options.client?.createCredential
      ? options.client.createCredential(request) : { credentialId: new Uint8Array([1, 2, 3]), prfEnabled: true, prfOutput: new Uint8Array(32).fill(7) }; },
    getCredential: async request => { calls.get.push(request); return options.client?.getCredential
      ? options.client.getCredential(request) : { credentialId: new Uint8Array([1, 2, 3]), prfOutput: new Uint8Array(32).fill(7) }; },
  };
  const storage = { getItem: (key: string) => records.get(key) ?? null,
    setItem: (key: string, value: string) => { if (options.storageFails) throw new Error("Storage denied"); records.set(key, value); },
    removeItem: (key: string) => { records.delete(key); } };
  const controller = new AuthController({ policy: local, storage, client, now: options.now });
  return { controller, storage, records, client, calls };
}

test("RP policy pins the public host and separates local test accounts", () => {
  assert.equal(local.rpId, "localhost");
  assert.equal(authPolicy(`https://${PASSKEY_HOST}/login`, false, true, true).rpId, PASSKEY_HOST);
  for (const url of ["https://preview.vercel.app", "https://singu.online", `https://evil.${PASSKEY_HOST}`, `http://${PASSKEY_HOST}`, "http://localhost:18767"]) {
    assert.equal(authPolicy(url, false, true, true).rpId, null, url);
  }
  const ip = authPolicy("http://127.0.0.1:18767/signup", true, true, true);
  assert.equal(ip.rpId, null);
  assert.equal(ip.localUrl, "http://localhost:18767/signup");
  assert.equal(authPolicy("http://localhost", true, false, true).rpId, null);
  assert.equal(authPolicy(`https://${PASSKEY_HOST}`, false, true, false).rpId, null);
});

test("real SDK create/get and real derivation recover the same account; only public metadata persists", async () => {
  const f = setup();
  try {
    assert.equal(await f.controller.authenticate("signup"), true);
    const first = f.controller.getSnapshot().address;
    assert.match(first!, /^0x[0-9a-fA-F]{40}$/);
    const metadata = JSON.parse(f.records.get(storageKey)!);
    assert.deepEqual(Object.keys(metadata).sort(), ["address", "credentialId", "rpId", "version"]);
    assert.equal(f.calls.create[0].userVerification, "required");
    assert.equal(f.calls.create[0].residentKey, "required");
    assert.equal(f.calls.create[0].rp.id, "localhost");
    f.controller.signOut();
    assert.equal(f.controller.getSnapshot().address, null);
    assert.equal(await f.controller.authenticate("login"), true);
    assert.equal(f.controller.getSnapshot().address, first);
    assert.deepEqual(f.calls.get[0].allowCredential?.credentialId, new Uint8Array([1, 2, 3]));
    assert.deepEqual(f.calls.get[0].prfSalt, f.calls.create[0].prfSalt);
    assert.notDeepEqual(f.calls.get[0].challenge, f.calls.create[0].challenge);
    const reloaded = new AuthController({ policy: local, storage: f.storage, client: f.client });
    assert.equal(reloaded.getSnapshot().remembered, true);
    assert.equal(reloaded.getSnapshot().address, null);
    reloaded.signOut();
  } finally { f.controller.signOut(); }
});

test("signup falls back to a second PRF prompt when creation does not return output", async () => {
  const f = setup({ client: { createCredential: async () => ({ credentialId: new Uint8Array([1, 2, 3]), prfEnabled: true }) } });
  try { assert.equal(await f.controller.authenticate("signup"), true); assert.equal(f.calls.get.length, 1); }
  finally { f.controller.signOut(); }
});

test("sign in without remembered metadata recovers a discoverable passkey", async () => {
  const f = setup();
  try { assert.equal(await f.controller.authenticate("login"), true); assert.equal(f.calls.get[0].allowCredential, undefined); }
  finally { f.controller.signOut(); }
});

test("PRF unavailable and cancellation never report an authenticated account", async () => {
  for (const createCredential of [
    async () => ({ credentialId: new Uint8Array([1]), prfEnabled: false }),
    async () => { throw new DOMException("cancelled credential details", "NotAllowedError"); },
  ]) {
    const f = setup({ client: { createCredential } });
    assert.equal(await f.controller.authenticate("signup"), false);
    assert.equal(f.controller.getSnapshot().address, null);
    assert.equal(f.controller.getSnapshot().busy, false);
    assert.ok(f.controller.getSnapshot().error);
    assert.ok(!f.controller.getSnapshot().error?.includes("credential details"));
    assert.equal(f.records.size, 0);
  }
});

test("corrupt metadata does not authenticate; storage failure leaves a usable in-memory session", async () => {
  const f = setup({ initial: '{"version":1,"rpId":"wrong","address":"bogus"}', storageFails: true });
  try {
    assert.equal(f.controller.getSnapshot().remembered, false);
    assert.equal(await f.controller.authenticate("login"), true);
    assert.match(f.controller.getSnapshot().notice!, /cannot remember/);
    assert.equal(f.controller.getSnapshot().remembered, false);
  } finally { f.controller.signOut(); }
});

test("a known credential must return the same derived address", async () => {
  const f = setup({ initial: JSON.stringify({ version: 1, rpId: "localhost", credentialId: "AQID", address: `0x${"0".repeat(40)}` }) });
  assert.equal(await f.controller.authenticate("login"), false);
  assert.equal(f.controller.getSnapshot().address, null);
  assert.match(f.controller.getSnapshot().error!, /different account address/);
});

test("duplicate signup requires explicit consent; account switching is discoverable", async () => {
  const f = setup();
  try {
    await f.controller.authenticate("signup");
    f.controller.signOut();
    assert.equal(await f.controller.authenticate("signup"), false);
    assert.equal(f.calls.create.length, 1);
    assert.equal(await f.controller.authenticate("login", undefined, true), true);
    assert.equal(f.calls.get[0].allowCredential, undefined);
    assert.equal(await f.controller.authenticate("signup", undefined, false, true), true);
    assert.equal(f.calls.create.length, 2);
  } finally { f.controller.signOut(); }
});

test("parallel submits are blocked and sign-out invalidates a late ceremony result", async () => {
  let finish!: (result: WebAuthnClient.GetCredentialResult) => void;
  const f = setup({ client: { getCredential: () => new Promise(resolve => { finish = resolve; }) } });
  const pending = f.controller.authenticate("login");
  assert.equal(await f.controller.authenticate("login"), false);
  assert.equal(f.calls.get.length, 1);
  f.controller.signOut();
  finish({ credentialId: new Uint8Array([1, 2, 3]), prfOutput: new Uint8Array(32).fill(7) });
  assert.equal(await pending, false);
  assert.equal(f.controller.getSnapshot().address, null);
  assert.equal(f.records.size, 0);
});

test("expired sessions lock on clock checks after a suspended tab resumes", async () => {
  let now = 1_000;
  const f = setup({ now: () => now });
  try {
    await f.controller.authenticate("login");
    now += SESSION_MS;
    f.controller.checkExpiry();
    assert.equal(f.controller.getSnapshot().address, null);
    assert.match(f.controller.getSnapshot().notice!, /expired/);
  } finally { f.controller.signOut(); }
});

test("derived Mera sessions sign and reject signing after end", async () => {
  const account = deriveAccount(new Uint8Array(32).fill(7));
  const signature = await account.session.signDigest(new Uint8Array(32).fill(1));
  assert.equal(signature.compact.length, 64);
  account.session.end();
  await assert.rejects(account.session.signDigest(new Uint8Array(32)), { code: "SESSION_ENDED" });
});

test('sign-up refuses up front only when the browser explicitly lacks PRF', async () => {
  const { prfExplicitlyUnsupported } = await import('../src/auth/controller.ts');
  assert.equal(await prfExplicitlyUnsupported({ getClientCapabilities: async () => ({ 'extension:prf': false }) }), true);
  assert.equal(await prfExplicitlyUnsupported({ getClientCapabilities: async () => ({ 'extension:prf': true }) }), false);
  // Unknown or unreportable capabilities never block the normal flow.
  assert.equal(await prfExplicitlyUnsupported({ getClientCapabilities: async () => ({}) }), false);
  assert.equal(await prfExplicitlyUnsupported({ getClientCapabilities: async () => { throw Error('unsupported'); } }), false);
  assert.equal(await prfExplicitlyUnsupported({}), false);
  assert.equal(await prfExplicitlyUnsupported(undefined), false);
});

test('a sign-up that fails for missing PRF names working providers and how to remove the orphan passkey', async () => {
  const f = setup({ client: { createCredential: async () => ({ credentialId: new Uint8Array([1]), prfEnabled: false }) } });
  assert.equal(await f.controller.authenticate("signup"), false);
  const error = f.controller.getSnapshot().error ?? '';
  assert.match(error, /Google Password Manager/); assert.match(error, /iCloud Keychain/); assert.match(error, /delete it/);
});
