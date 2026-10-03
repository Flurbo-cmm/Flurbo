import {
  createPasskeyWithPrfOutput, getPasskeyPrfOutput, createSecp256k1SigningSession,
  getEvmAddress, isMeraError,
  type Secp256k1SigningSession, type WebAuthnClient,
} from "@category-labs/mera";
import { HDKey, HARDENED_OFFSET } from "@scure/bip32";
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { SESSION_MS, type AuthPolicy } from "./policy.ts";
import { hashMessage, hexToBytes, bytesToHex, serializeSignature, type Hex } from 'viem';
import type { SessionTransport } from './server-session.ts';

type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Remembered = { version: 1; rpId: string; credentialId: string; address: string };
export type AuthSnapshot = {
  method: 'passkey' | 'wallet';
  busy: boolean; address: string | null; expiresAt: number | null;
  signingExpiresAt: number | null; restoring: boolean;
  remembered: boolean; error: string | null; notice: string | null;
};

// Matches Mera's documented BIP-39 / BIP-44 EVM account recipe, index 0.
// These derivation choices are part of account identity and must not change silently.
export function deriveAccount(prfOutput: Uint8Array) {
  if (prfOutput.length !== 32) throw new Error("Invalid account entropy");
  let seed: Uint8Array | undefined;
  let node: HDKey | undefined;
  let key: Uint8Array | null = null;
  let session: Secp256k1SigningSession | undefined;
  try {
    seed = mnemonicToSeedSync(entropyToMnemonic(prfOutput, wordlist));
    node = HDKey.fromMasterSeed(seed);
    for (const index of [44 + HARDENED_OFFSET, 60 + HARDENED_OFFSET, HARDENED_OFFSET, 0, 0]) {
      const child: HDKey = node!.deriveChild(index);
      node!.wipePrivateData();
      node = child;
    }
    key = node!.privateKey;
    if (!key) throw new Error("Account derivation failed");
    session = createSecp256k1SigningSession({ privateKey: key });
    return { session, address: getEvmAddress(session.publicKey) };
  } catch (error) {
    session?.end();
    throw error;
  } finally {
    key?.fill(0);
    node?.wipePrivateData();
    seed?.fill(0);
  }
}

const PRF_PROVIDERS = "Use Chrome or Edge with Google Password Manager, Safari with iCloud Keychain, or a recent 1Password";
// The provider only reports missing PRF after it has saved a passkey, so explain how to remove it.
export const PRF_FAILED_SIGNUP_MESSAGE = `This passkey manager does not support the feature Mera needs (PRF), so Flurbo could not open an account. It may still have saved a passkey named for Flurbo: delete it in that password manager's settings, since it can never sign in. ${PRF_PROVIDERS}, then create your account again.`;
const PRF_FAILED_SIGNIN_MESSAGE = `This passkey manager does not support the feature Mera needs (PRF), so this passkey cannot open a Flurbo account. ${PRF_PROVIDERS}. If you created this passkey with another manager, sign in there.`;
export const PRF_UNSUPPORTED_MESSAGE = `This browser or passkey manager cannot create a Flurbo account: it lacks the passkey feature Mera needs (PRF). No passkey was created. ${PRF_PROVIDERS}, then try again.`;

// Asks the browser before creating a passkey. Only an explicit "no" blocks sign-up; browsers that
// cannot report capabilities continue to the normal flow and its existing PRF error handling.
export async function prfExplicitlyUnsupported(credential: unknown = globalThis.PublicKeyCredential): Promise<boolean> {
  const probe = (credential as { getClientCapabilities?: () => Promise<Record<string, boolean | undefined>> } | undefined)?.getClientCapabilities;
  if (typeof probe !== "function") return false;
  try { return (await probe.call(credential))["extension:prf"] === false; } catch { return false; }
}

function friendlyError(error: unknown, creating: boolean): string {
  if (isMeraError(error)) {
    if (error.code === "PRF_UNAVAILABLE") return creating ? PRF_FAILED_SIGNUP_MESSAGE : PRF_FAILED_SIGNIN_MESSAGE;
    if (error.code === "PASSKEY_OPERATION_FAILED") return creating
      ? "Passkey setup was cancelled or could not finish. If your device saved a passkey, try Sign in before creating another."
      : "Sign-in was cancelled or could not finish. Try again, or choose another passkey.";
  }
  // Never surface raw SDK exceptions, which may contain credential details.
  return "The account could not be opened. Try signing in again with your existing passkey.";
}

export class AuthController {
  readonly policy: AuthPolicy;
  #storage?: StoragePort;
  #transport?: SessionTransport;
  #client?: WebAuthnClient;
  #now: () => number;
  #errorMessage: typeof friendlyError;
  #key: string;
  #session?: Secp256k1SigningSession;
  #timer?: ReturnType<typeof setTimeout>;
  #generation = 0;
  #inFlight = false;
  #signedOut = false;
  #listeners = new Set<() => void>();
  #snapshot: AuthSnapshot;

  constructor(options: { policy: AuthPolicy; storage?: StoragePort; client?: WebAuthnClient; now?: () => number; transport?: SessionTransport; errorMessage?: typeof friendlyError }) {
    this.policy = options.policy;
    this.#storage = options.storage;
    this.#transport = options.transport;
    this.#client = options.client;
    this.#now = options.now ?? Date.now;
    this.#errorMessage = options.errorMessage ?? friendlyError;
    this.#key = `flurbo.passkey.v1:${this.policy.rpId ?? "unavailable"}`;
    this.#snapshot = { method: 'passkey', busy: false, address: null, expiresAt: null, signingExpiresAt: null, restoring: !!options.transport, remembered: !!this.#read(), error: null, notice: null };
  }

  getSnapshot = () => this.#snapshot;
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  #update(patch: Partial<AuthSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...patch };
    this.#listeners.forEach(listener => listener());
  }
  #read(): Remembered | undefined {
    try {
      const value = JSON.parse(this.#storage?.getItem(this.#key) ?? "null");
      if (value?.version === 1 && value.rpId === this.policy.rpId &&
          typeof value.credentialId === "string" && /^[A-Za-z0-9_-]{1,2048}$/.test(value.credentialId) &&
          typeof value.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(value.address)) return value;
    } catch { /* Missing or malformed metadata is not an authenticated account. */ }
    return undefined;
  }
  #endSession() { clearTimeout(this.#timer); this.#session?.end(); this.#session = undefined; }
  lockSigning = () => {
    this.#generation++;
    this.#endSession();
    this.#update({ busy: false, signingExpiresAt: null });
  };
  restore = async () => {
    if (!this.#transport || this.#inFlight || this.#signedOut) return;
    const generation = this.#generation;
    try {
      const login = await this.#transport.read();
      if (generation !== this.#generation) return;
      if (!login || login.method === 'wallet' || login.expiresAt <= this.#now() || !/^0x[0-9a-fA-F]{40}$/.test(login.address)) {
        this.#endSession(); this.#update({ address: null, expiresAt: null, signingExpiresAt: null });
      } else {
        if (this.#snapshot.address?.toLowerCase() !== login.address.toLowerCase()) {
          this.#endSession(); this.#update({ signingExpiresAt: null });
        }
        this.#update({ address: login.address, expiresAt: login.expiresAt, method: login.method || 'passkey' });
      }
    } catch { if (generation === this.#generation) this.#update({ notice: 'Account service is unavailable. Sign in again before continuing.' }); }
    finally { if (generation === this.#generation) this.#update({ restoring: false }); }
  };
  async signDigest(_digest: Hex): Promise<Awaited<ReturnType<Secp256k1SigningSession['signDigest']>>> {
    throw new Error('Mera is for account access only. Use MetaMask for transactions.');
  }
  signOut = (notice: string | null = null) => {
    this.#signedOut = true;
    this.#generation++;
    this.#endSession();
    this.#update({ busy: false, restoring: false, address: null, expiresAt: null, signingExpiresAt: null, error: null, notice });
    return this.#transport?.logout().catch(() => { this.#update({ error: 'Server sign-out could not finish. Retry sign-out when the service is reachable.' }); });
  };
  checkExpiry = () => {
    if (this.#snapshot.expiresAt !== null && this.#now() >= this.#snapshot.expiresAt) {
      this.signOut("Your session expired. Sign in again to open your account.");
    } else if (this.#snapshot.signingExpiresAt !== null && this.#now() >= this.#snapshot.signingExpiresAt) {
      this.lockSigning();
    }
  };

  async authenticate(mode: "signup" | "login", name = "Flurbo account", chooseAnother = false, allowNew = false): Promise<boolean> {
    if (this.#inFlight) return false;
    if (!this.policy.rpId) { this.#update({ error: this.policy.reason }); return false; }
    const known = this.#read();
    if (mode === "signup" && known && !allowNew) {
      this.#update({ error: "A passkey is already remembered here. Sign in, or confirm that you want a separate account." });
      return false;
    }
    // Only the browser's own WebAuthn is probed; injected clients (mobile, tests) report their own errors.
    if (mode === "signup" && !this.#client && await prfExplicitlyUnsupported()) {
      this.#update({ error: PRF_UNSUPPORTED_MESSAGE });
      return false;
    }
    if (this.#inFlight) return false;
    this.#endSession();
    this.#inFlight = true;
    const generation = ++this.#generation;
    this.#update({ busy: true, signingExpiresAt: null, error: null, notice: null });
    let result: { credentialId: string; prfOutput: Uint8Array } | undefined;
    let derived: ReturnType<typeof deriveAccount> | undefined;
    try {
      const label = name.trim().slice(0, 48) || "Flurbo account";
      result = mode === "signup"
        ? await createPasskeyWithPrfOutput({ rp: { id: this.policy.rpId, name: this.policy.local ? "Flurbo local test" : "Flurbo" },
            user: { name: label, displayName: label }, timeout: 60_000, webAuthnClient: this.#client })
        : await getPasskeyPrfOutput({ rpId: this.policy.rpId,
            credential: !chooseAnother && known ? { credentialId: known.credentialId } : undefined,
            timeout: 60_000, webAuthnClient: this.#client });
      if (generation !== this.#generation) return false;
      if (mode === "login" && !chooseAnother && known && known.credentialId !== result.credentialId) {
        this.#update({ error: "A different passkey was returned. Use Choose another passkey to switch accounts." });
        return false;
      }
      derived = deriveAccount(result.prfOutput);
      if (known?.credentialId === result.credentialId && known.address.toLowerCase() !== derived.address.toLowerCase()) {
        this.#update({ error: "This passkey returned a different account address. Sign-in was stopped to protect your existing account." });
        return false;
      }
      let loginExpiry = this.#now() + SESSION_MS;
      if (this.#transport) {
        const message = await this.#transport.challenge(derived.address);
        if (generation !== this.#generation) return false;
        const signature = await derived.session.signDigest(hexToBytes(hashMessage(message)));
        const login = await this.#transport.verify(serializeSignature({ r: bytesToHex(signature.compact.slice(0, 32)), s: bytesToHex(signature.compact.slice(32)), yParity: signature.recovery }));
        if (generation !== this.#generation) { await this.#transport.logout(); return false; }
        if (login.address.toLowerCase() !== derived.address.toLowerCase() || login.expiresAt <= this.#now()) throw new Error('Login proof mismatch');
        loginExpiry = login.expiresAt;
      }
      let notice: string | null = null;
      let remembered = false;
      try {
        if (!this.#storage) throw new Error("Storage unavailable");
        const record: Remembered = { version: 1, rpId: this.policy.rpId, credentialId: result.credentialId, address: derived.address };
        this.#storage.setItem(this.#key, JSON.stringify(record));
        remembered = true;
      } catch { notice = "This browser cannot remember the account. Next time, choose your passkey from the device prompt."; }
      // The passkey signs only the login challenge. No transaction signer survives login.
      derived.session.end();
      const address = derived.address.toLowerCase();
      derived = undefined;
      this.#signedOut = false;
      const expiresAt = loginExpiry;
      this.#timer = setTimeout(this.checkExpiry, SESSION_MS);
      this.#update({ method: 'passkey', address, expiresAt, signingExpiresAt: null, restoring: false, remembered, notice });
      return true;
    } catch (error) {
      if (generation === this.#generation) this.#update({ error: this.#errorMessage(error, mode === "signup") });
      return false;
    } finally {
      result?.prfOutput.fill(0);
      derived?.session.end();
      this.#inFlight = false;
      if (generation === this.#generation) this.#update({ busy: false });
    }
  }
}
