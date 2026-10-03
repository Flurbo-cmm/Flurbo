import assert from 'node:assert/strict';
import test from 'node:test';
import { MobileAccount, parseAccount, RP_ID } from './account.ts';
import { deriveAccount } from './identity.ts';
import { deriveAccount as webAccount } from '../../web/src/auth/controller.ts';
import type { WebAuthnClient } from '@category-labs/mera';

test('mobile identity exactly matches existing web accounts', () => {
  for (const fill of [0, 1, 42, 255]) {
    const entropy = new Uint8Array(32).fill(fill);
    const mobile = deriveAccount(entropy), web = webAccount(entropy);
    try { assert.equal(mobile.address, web.address.toLowerCase()); }
    finally { mobile.session.end(); web.session.end(); entropy.fill(0); }
  }
  assert.throws(() => deriveAccount(new Uint8Array(31)));
});
function fixture() {
  let stored: string | null = null;
  let entropy = new Uint8Array(32).fill(7);
  const client: WebAuthnClient = {
    createCredential: async options => {
      assert.equal(options.rp.id, RP_ID);
      return { credentialId: new Uint8Array([1, 2, 3]), prfEnabled: true, prfOutput: entropy };
    },
    getCredential: async options => {
      assert.equal(options.rpId, RP_ID);
      return { credentialId: new Uint8Array([1, 2, 3]), prfOutput: entropy };
    },
  };
  const storage = { get: async () => stored, set: async (x: string) => { stored = x; }, remove: async () => { stored = null; } };
  return { client, storage, stored: () => stored, fresh: () => { entropy = new Uint8Array(32).fill(7); } };
}
test('restoration remembers a wallet without restoring signing material', async () => {
  const f = fixture(), account = new MobileAccount(f.storage, f.client);
  try {
    assert.equal(await account.authenticate('signup'), true);
    assert.ok(account.getSnapshot().unlockedUntil);
    assert.deepEqual(Object.keys(JSON.parse(f.stored()!)).sort(), ['address', 'credentialId', 'rpId', 'version']);
    const restored = new MobileAccount(f.storage, f.client);
    await restored.restore();
    assert.equal(restored.getSnapshot().address, account.getSnapshot().address);
    assert.equal(restored.getSnapshot().unlockedUntil, null);
    assert.equal(await restored.authenticate('signup'), false);
    f.fresh(); assert.equal(await restored.authenticate('login'), true);
    await restored.signOut(); assert.equal(f.stored(), null);
    assert.equal(restored.getSnapshot().address, null);
  } finally { account.lock(); }
});
test('background lock invalidates an in-flight passkey result', async () => {
  const f = fixture();
  let resolve!: (value: WebAuthnClient.GetCredentialResult) => void;
  f.client.getCredential = async () => new Promise(r => { resolve = r; });
  const account = new MobileAccount(f.storage, f.client);
  const pending = account.authenticate('login');
  account.lock(); resolve({ credentialId: new Uint8Array([1]), prfOutput: new Uint8Array(32).fill(8) });
  assert.equal(await pending, false);
  assert.equal(account.getSnapshot().unlockedUntil, null);
  assert.equal(f.stored(), null);
});
test('PRF failure is explicit and never produces a funded-looking account', async () => {
  const f = fixture();
  f.client.getCredential = async () => ({ credentialId: new Uint8Array([1]) });
  const account = new MobileAccount(f.storage, f.client);
  assert.equal(await account.authenticate('login'), false);
  assert.equal(account.getSnapshot().address, null);
  assert.match(account.getSnapshot().error!, /PRF/);
  assert.equal(f.stored(), null);
});
test('untrusted remembered records do not cross RP boundaries', () => {
  assert.equal(parseAccount('bad json'), null);
  assert.equal(parseAccount(JSON.stringify({ version: 1, rpId: 'other.site', credentialId: 'AQID', address: '0x' + '11'.repeat(20) })), null);
});
