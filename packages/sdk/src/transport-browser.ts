import {scheduledFetch} from './request-scheduler.ts';
import type { Transport } from './client.ts';

// Browser transport. Same-origin requests reuse the existing HttpOnly Flurbo session cookie; the SDK never
// reads, stores or forwards it. Only this module touches fetch.
type FetchLike = (input: string, init: { method: string; credentials: 'same-origin'; cache: 'no-store'; headers: Record<string, string>; body?: string; signal: AbortSignal })
  => Promise<{ status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;

export function browserTransport(options: { baseUrl?: string; fetch?: FetchLike } = {}): Transport {
  const base = options.baseUrl ?? '';
  const doFetch = options.fetch ?? ((scheduledFetch as FetchLike));
  return {
    kind: 'live',
    async send({ method, path, body, signal }) {
      const response = await doFetch(base + path, { method, credentials: 'same-origin', cache: 'no-store',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal });
      let parsed: unknown = null;
      try { parsed = await response.json(); } catch { parsed = null; }
      return { status: response.status, body: parsed, retryAfter: response.headers.get('Retry-After') };
    },
  };
}
