import { createPasskeyWithPrfOutput, getPasskeyPrfOutput, isMeraError, type WebAuthnClient } from '@category-labs/mera';
import { deriveAccount } from './identity.ts';
import { passkeyErrorMessage } from './passkey-errors.ts';

export const RP_ID = 'flurbo.singu.online';
export const ACCOUNT_KEY = 'flurbo.mobile.account.v1';
export const SIGNING_MS = 60 * 60 * 1000;
export type RememberedAccount = { version: 1; rpId: string; credentialId: string; address: string };
export type AccountState = { address: string | null; remembered: boolean; busy: boolean; unlockedUntil: number | null; error: string | null };
type Storage = { get(): Promise<string | null>; set(value: string): Promise<void>; remove(): Promise<void> };

export function parseAccount(raw: string | null): RememberedAccount | null {
  try {
    const value = JSON.parse(raw || 'null');
    return value?.version === 1 && value.rpId === RP_ID &&
      typeof value.credentialId === 'string' && /^[A-Za-z0-9_-]{1,2048}$/.test(value.credentialId) &&
      typeof value.address === 'string' && /^0x[0-9a-f]{40}$/i.test(value.address)
      ? { version: 1, rpId: RP_ID, credentialId: value.credentialId, address: value.address.toLowerCase() } : null;
  } catch { return null; }
}

// Saved metadata is a read-only wallet bookmark, not a signing session or backend login.
// No PRF output, mnemonic, private key or signing session is persisted.
export class MobileAccount {
  private saved: RememberedAccount | null = null;
  private key: ReturnType<typeof deriveAccount> | null = null;
  private generation = 0;
  private inFlight = false;
  private timer?: ReturnType<typeof setTimeout>;
  private listeners = new Set<() => void>();
  private state: AccountState = { address: null, remembered: false, busy: false, unlockedUntil: null, error: null };
  private storage: Storage;
  private client: WebAuthnClient;
  private now: () => number;
  constructor(storage: Storage, client: WebAuthnClient, now = Date.now) { this.storage = storage; this.client = client; this.now = now; }
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  private update(patch: Partial<AccountState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(fn => fn()); }
  restore = async () => {
    const generation = this.generation;
    try {
      const saved = parseAccount(await this.storage.get());
      if (generation !== this.generation || this.inFlight) return;
      this.saved = saved;
      this.update({ address: saved?.address ?? null, remembered: !!saved });
    } catch { if (generation === this.generation) this.update({ error: 'Saved account unavailable. Sign in with your passkey.' }); }
  };
  lock = () => {
    this.generation++;
    clearTimeout(this.timer);
    this.key?.session.end(); this.key = null;
    this.update({ unlockedUntil: null });
  };
  signOut = async () => {
    this.lock(); this.saved = null;
    this.update({ address: null, remembered: false, error: null });
    try { await this.storage.remove(); }
    catch { this.update({ error: 'Signing is locked, but the saved wallet could not be removed. Retry sign out.' }); }
  };
  async authenticate(mode: 'login' | 'signup', chooseAnother = false) {
    if (this.inFlight) return false;
    if (mode === 'signup' && this.saved) { this.update({ error: 'Sign in with your existing passkey. Sign out first to create a separate wallet.' }); return false; }
    this.lock(); this.inFlight = true;
    const generation = this.generation;
    this.update({ busy: true, error: null });
    let result: { credentialId: string; prfOutput: Uint8Array } | undefined;
    let derived: ReturnType<typeof deriveAccount> | undefined;
    try {
      result = mode === 'signup'
        ? await createPasskeyWithPrfOutput({ rp: { id: RP_ID, name: 'Flurbo' }, user: { name: 'Flurbo account', displayName: 'Flurbo account' }, timeout: 60_000, webAuthnClient: this.client })
        : await getPasskeyPrfOutput({ rpId: RP_ID, credential: !chooseAnother && this.saved ? { credentialId: this.saved.credentialId } : undefined, timeout: 60_000, webAuthnClient: this.client });
      if (generation !== this.generation) return false;
      if (mode === 'login' && !chooseAnother && this.saved && result.credentialId !== this.saved.credentialId) throw new Error('Unexpected credential');
      derived = deriveAccount(result.prfOutput);
      if (this.saved?.credentialId === result.credentialId && this.saved.address !== derived.address) throw new Error('Account identity mismatch');
      const record: RememberedAccount = { version: 1, rpId: RP_ID, credentialId: result.credentialId, address: derived.address };
      // Persist only public metadata. A storage failure leaves signing closed.
      await this.storage.set(JSON.stringify(record));
      if (generation !== this.generation) { await this.storage.remove(); return false; }
      this.saved = record; this.key = derived; derived = undefined;
      const unlockedUntil = this.now() + SIGNING_MS;
      this.timer = setTimeout(this.lock, SIGNING_MS);
      this.update({ address: record.address, remembered: true, unlockedUntil });
      return true;
    } catch (error) {
      if (generation === this.generation) this.update({ error: passkeyErrorMessage(error) });
      return false;
    } finally {
      result?.prfOutput.fill(0); derived?.session.end();
      this.inFlight = false; this.update({ busy: false });
    }
  }
}
