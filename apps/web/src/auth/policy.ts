export const PASSKEY_HOST = "flurbo.singu.online";
export const COMPANY_PASSKEY_HOST = "flurbopm.singu.online";
export const COMPANY_HOST = "flurbo.tech";
export const COMPANY_HOSTS: readonly string[] = [COMPANY_HOST, COMPANY_PASSKEY_HOST];
export const SESSION_MS = 60 * 60 * 1000;

export type AuthPolicy = { rpId: string | null; local: boolean; reason: string | null; localUrl?: string };

export function authPolicy(url: string, development: boolean, secure: boolean, supported: boolean): AuthPolicy {
  const location = new URL(url);
  if (development && location.hostname === "127.0.0.1") {
    return { rpId: null, local: true, reason: "Open localhost to use a local test passkey.",
      localUrl: `http://localhost:${location.port || "18767"}${location.pathname}` };
  }
  const local = development && location.hostname === "localhost";
  if (!local && (location.protocol !== "https:" || ![PASSKEY_HOST, ...COMPANY_HOSTS].includes(location.hostname))) {
    return { rpId: null, local: false, reason: "Passkey access requires a supported Flurbo HTTPS domain." };
  }
  if (!secure || !supported) return { rpId: null, local, reason: "This browser does not provide secure passkey access. Open this page in a supported browser." };
  // Existing accounts are derived from passkeys registered for the old company host. flurbo.tech keeps using that
  // relying party through WebAuthn related origins (the old host lists flurbo.tech in /.well-known/webauthn).
  const rpId = local ? "localhost" : location.hostname === COMPANY_HOST ? COMPANY_PASSKEY_HOST : location.hostname;
  return { rpId, local, reason: null };
}
