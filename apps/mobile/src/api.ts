import {scheduledFetch} from '../../../packages/sdk/src/request-scheduler.ts';
import type { SessionTransport } from '../../web/src/auth/server-session';
export const ORIGIN = 'https://flurbo.singu.online';
export class AccountServiceError extends Error { readonly code = 'ACCOUNT_SERVICE_UNAVAILABLE'; }

export function createApiTransport(request: typeof fetch): typeof fetch {
  return async (input, init = {}) => {
    if (typeof input !== 'string' || !input.startsWith('/api/') || input.includes('\\') || /[\r\n]/.test(input)) throw new Error('Unsupported Flurbo API path');
    const url = new URL(input, ORIGIN);
    if (url.origin !== ORIGIN || !url.pathname.startsWith('/api/')) throw new Error('Unsupported Flurbo API origin');
    const headers = new Headers(init.headers);
    headers.set('Origin', ORIGIN);
    // Native networking uses the platform cookie jar. No cookie, session token,
    // private RPC URL or signing key is copied into AsyncStorage or URLs.
    const response = await request(url.href, { ...init, headers, credentials: 'include', redirect: 'error' });
    if (response.url && new URL(response.url).origin !== ORIGIN) throw new Error('Flurbo API redirected to another origin');
    return response;
  };
}
export const apiFetch = createApiTransport((input, init) => scheduledFetch(input, init));
export async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) abort.abort();
  const timer = setTimeout(cancel, 60_000);
  try {
    const response = await apiFetch(path, { signal: abort.signal, cache: 'no-store',
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json();
    if (!response.ok) throw new Error(response.status === 401 ? 'Sign in again to continue.' : typeof value.error === 'string' ? value.error : 'Flurbo could not complete this request. Try again shortly.');
    return value as T;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
async function accountApi<T>(path: string, body?: unknown): Promise<T> {
  try { return await api<T>(path, body); } catch { throw new AccountServiceError('Flurbo account service is unavailable.'); }
}
export const sessionTransport: SessionTransport = {
  read: async () => (await accountApi<{ session: Awaited<ReturnType<SessionTransport['read']>> }>('/api/auth/session')).session,
  challenge: async address => (await accountApi<{ message: string }>('/api/auth/challenge', { address, method: 'passkey' })).message,
  verify: async signature => (await accountApi<{ session: Awaited<ReturnType<SessionTransport['verify']>> }>('/api/auth/verify', { signature })).session,
  logout: async () => { await api('/api/auth/logout', {}); },
};
