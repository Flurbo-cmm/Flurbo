export type LoginSession = { address: string; expiresAt: number; method?: 'passkey' | 'wallet' };
export interface SessionTransport {
  read(): Promise<LoginSession | null>;
  challenge(address: string): Promise<string>;
  verify(signature: string): Promise<LoginSession>;
  logout(): Promise<void>;
}
async function request(path: string, body?: object) {
  const response = await fetch(`/api/auth/${path}`, { credentials: 'same-origin', cache: 'no-store',
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error('Account service unavailable');
  return response.json();
}
export const serverSession: SessionTransport = {
  read: async () => (await request('session')).session,
  challenge: async address => (await request('challenge', { address, method: 'passkey' })).message,
  verify: async signature => (await request('verify', { signature })).session,
  logout: async () => { await request('logout', {}); },
};
