export const PASSKEY_HOST = "flurbo.singu.online";
export const SESSION_MS = 60 * 60 * 1000;

export type AuthPolicy = { rpId: string | null; local: boolean; reason: string | null; localUrl?: string };

export function authPolicy(url: string, development: boolean, secure: boolean, supported: boolean): AuthPolicy {
  const location = new URL(url);
  if (development && location.hostname === "127.0.0.1") {
    return { rpId: null, local: true, reason: "Open localhost to use a local test passkey.",
      localUrl: `http://localhost:${location.port || "18767"}${location.pathname}` };
  }
  const local = development && location.hostname === "localhost";
  if (!local && (location.hostname !== PASSKEY_HOST || location.protocol !== "https:")) {
    return { rpId: null, local: false, reason: `Passkey access is available only at https://${PASSKEY_HOST}.` };
  }
  if (!secure || !supported) return { rpId: null, local, reason: "This browser does not provide secure passkey access. Open this page in a supported browser." };
  return { rpId: local ? "localhost" : PASSKEY_HOST, local, reason: null };
}
