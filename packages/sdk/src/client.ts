import {retryAfterMs} from './request-scheduler.ts';
import { FlurboError, type FlurboErrorCode } from './errors.ts';
import { type Claim, claimToJSON } from './claims.ts';
import { type ClaimImplied, type DirectoryEntry, type Market, type Namespace, type PairImplied, type QuoteResult, isNamespace, parseClaimImplied, parseDirectory, parseMarket, parsePairAnalytics, parseQuoteResult } from './market.ts';

// Transport is injected. The browser transport reuses the signed-in Flurbo session cookie. There is no
// cookie-export path for Node: headless use starts with the fixture transport, and any future headless
// credential must be scoped, revocable and read-only. A read credential never implies signing authority.
export type HttpRequest = { method: 'GET' | 'POST'; path: string; body?: unknown; signal: AbortSignal };
export type HttpResponse = { status: number; body: unknown; retryAfter: string | null };
export type Transport = { kind: 'live' | 'fixture'; send(request: HttpRequest): Promise<HttpResponse> };

export type ClientOptions = { transport: Transport; timeoutMs?: number; readRetries?: number; sleep?: (ms: number) => Promise<void> };
const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const end = Date.now() + ms;
  let timer: ReturnType<typeof setTimeout>;
  const abort = () => { clearTimeout(timer); reject(new FlurboError('aborted', 'The request was cancelled.')); };
  const tick = () => { const left=end-Date.now(); if(left<=0){signal?.removeEventListener('abort',abort);resolve();}else timer=setTimeout(tick,Math.min(left,60_000)); };
  if(signal?.aborted){abort();return;} signal?.addEventListener('abort',abort,{once:true}); tick();
});

function errorFor(status: number, body: unknown, retryAfter: string | null): FlurboError {
  const b = (body && typeof body === 'object' ? body : {}) as { error?: unknown; code?: unknown };
  const message = typeof b.error === 'string' && b.error.length < 300 ? b.error : 'The request was rejected.';
  const retry = retryAfter ? Math.ceil(retryAfterMs(retryAfter) / 1000) : null;
  const code: FlurboErrorCode = status === 401 ? 'unauthenticated' : status === 403 ? (b.code === 'INVITE_REQUIRED' ? 'invite_required' : 'forbidden')
    : status === 404 ? 'not_found' : status === 409 ? 'conflict' : status === 429 ? 'rate_limited' : status === 400 ? 'invalid_input'
    : status >= 500 ? 'unavailable' : 'invalid_response';
  return new FlurboError(code, message, { status, retryAfterSeconds: retry });
}

export function createClient(options: ClientOptions) {
  const { transport } = options, timeoutMs = options.timeoutMs ?? 20_000, readRetries = Math.min(Math.max(options.readRetries ?? 2, 0), 4);

  // One attempt. Timeouts and caller cancellation surface as typed errors.
  async function once(method: 'GET' | 'POST', path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(timeoutMs), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: HttpResponse;
    try { response = await transport.send({ method, path, body, signal: combined }); }
    catch (error) {
      if (signal?.aborted) throw new FlurboError('aborted', 'The request was cancelled.');
      if (timeout.aborted) throw new FlurboError('timeout', 'The request timed out.');
      if (error instanceof FlurboError) throw error;
      throw new FlurboError('network', 'The Flurbo server could not be reached.');
    }
    if (response.status < 200 || response.status > 299) throw errorFor(response.status, response.body, response.retryAfter);
    return response.body;
  }
  // Reads retry a bounded number of times on outages and rate limits. Mutations never retry: a lost
  // response could otherwise duplicate a record. Transaction submission never goes through the SDK.
  async function read(method: 'GET' | 'POST', path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try { return await once(method, path, body, signal); }
      catch (error) {
        const e = error as FlurboError, retryable = ['unavailable', 'rate_limited', 'network', 'timeout'].includes(e.code);
        if (!retryable || attempt >= readRetries || signal?.aborted) throw error;
        const wait = e.retryAfterSeconds !== null ? e.retryAfterSeconds * 1000 : 250 * 2 ** attempt + Math.floor(Math.random() * 150);
        if(options.sleep)await options.sleep(wait);else await defaultSleep(wait,signal);
      }
    }
  }
  const mutate = (path: string, body: unknown, signal?: AbortSignal) => once('POST', path, body, signal);
  const ns = (namespace: Namespace) => { if (!isNamespace(namespace)) throw new FlurboError('invalid_input', 'Unknown market namespace.'); return namespace; };

  return {
    mode: transport.kind,
    async directory(signal?: AbortSignal): Promise<DirectoryEntry[]> { return parseDirectory(await read('GET', '/api/market-directory', undefined, signal)); },
    async market(namespace: Namespace, signal?: AbortSignal): Promise<Market> { return parseMarket(await read('GET', `/api/${ns(namespace)}/markets`, undefined, signal), namespace); },
    async pairImplied(namespace: Namespace, pool: string, a: number, b: number, signal?: AbortSignal): Promise<PairImplied> {
      return parsePairAnalytics(await read('POST', `/api/${ns(namespace)}/analytics`, { a, b }, signal), pool);
    },
    async claimImplied(namespace: Namespace, claim: Claim, eventCount: number, signal?: AbortSignal): Promise<ClaimImplied> {
      return parseClaimImplied(await read('POST', `/api/${ns(namespace)}/claim-analytics`, { scope: claim.scope, mask: claim.mask.toString() }, signal), claim.pool, eventCount);
    },
    async quote(namespace: Namespace, claim: Claim, quantityAtoms: bigint, eventCount: number, side: 'buy' | 'sell' = 'buy', signal?: AbortSignal): Promise<QuoteResult> {
      const c = claimToJSON(claim);
      return parseQuoteResult(await read('POST', '/api/agents/quote', { namespace: ns(namespace), scope: c.scope, mask: c.mask, quantityAtoms: quantityAtoms.toString(), side }, signal), eventCount);
    },
    // Agent profiles and records. Ownership comes from the server session, never from these inputs.
    agents: {
      list: (signal?: AbortSignal) => read('GET', '/api/agents', undefined, signal),
      get: (id: string, signal?: AbortSignal) => read('GET', `/api/agents/${encodeId(id)}`, undefined, signal),
      create: (input: unknown, signal?: AbortSignal) => mutate('/api/agents', input, signal),
      update: (id: string, input: unknown, signal?: AbortSignal) => mutate(`/api/agents/${encodeId(id)}/update`, input, signal),
      remove: (id: string, signal?: AbortSignal) => mutate(`/api/agents/${encodeId(id)}/delete`, {}, signal),
      evaluate: (id: string, input: unknown, signal?: AbortSignal) => mutate(`/api/agents/${encodeId(id)}/evaluate`, input, signal),
      paper: (id: string, decisionId: string, signal?: AbortSignal) => mutate(`/api/agents/${encodeId(id)}/paper`, { decisionId }, signal),
      propose: (id: string, decisionId: string, owner: string, signal?: AbortSignal) => mutate(`/api/agents/${encodeId(id)}/proposal`, { decisionId, owner }, signal),
      performance: (id: string, signal?: AbortSignal) => read('POST', `/api/agents/${encodeId(id)}/performance`, {}, signal),
      track: (id: string, proposalId: string, input: unknown, signal?: AbortSignal) => mutate(`/api/agents/${encodeId(id)}/proposals/${encodeId(proposalId)}`, input, signal),
    },
  };
}
export type FlurboClient = ReturnType<typeof createClient>;

const encodeId = (id: string) => { if (!/^[a-z0-9-]{8,64}$/.test(id)) throw new FlurboError('invalid_input', 'Invalid identifier.'); return id; };
