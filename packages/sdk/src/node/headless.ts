import {scheduledFetch} from '../request-scheduler.ts';
import { FlurboError } from '../errors.ts';
import { PROTOCOL_HEADER, PROTOCOL_VERSION, RUNTIME_API_BASE, STOP_CODES, parseDeployment, type Deployment, type RuntimeErrorCode } from '../protocol.ts';
import type { FlurboPolicy } from '../policy.ts';

// Headless transport for the Flurbo agent runtime API. The credential is sent only in the Authorization
// header, never in a URL, and never included in errors or logs. Separate from the browser transport,
// which reuses the signed-in session cookie.
export class RuntimeApiError extends FlurboError {
  readonly apiCode: RuntimeErrorCode | 'NETWORK';
  readonly stop: boolean;
  readonly retryAfterSeconds: number | null;
  constructor(apiCode: RuntimeErrorCode | 'NETWORK', message: string, status: number | null, retryAfter: number | null) {
    super(status === 401 ? 'unauthenticated' : status === 403 ? 'forbidden' : status === 429 ? 'rate_limited' : status === 404 ? 'not_found' : status === 409 ? 'conflict' : 'unavailable', message, { status, retryAfterSeconds: retryAfter });
    this.apiCode = apiCode; this.stop = STOP_CODES.includes(apiCode as RuntimeErrorCode); this.retryAfterSeconds = retryAfter;
  }
}
export type RuntimePolicy = FlurboPolicy & { schema: 'flurbo.agent-runtime-policy.v1'; markets: string[]; serverTime: number; acknowledged?: boolean };
export type Heartbeat = { runtimeId: string; sdk: { language: 'typescript'; version: string }; mode: 'paper' | 'live'; state: 'running' | 'paused' | 'blocked' | 'stopping' | 'stopped';
  policy: { hash: string; flurboVersion: number | null; summary: Record<string, unknown> }; pending: number; startedAt: number; lastCycleAt?: number | null; lastErrorCode?: string | null };
export type ExecutionReport = { namespace: string; hash: string; intent: { action: string; claim: { scope: number; mask: string } | null; quantityAtoms: string; limitAtoms: string; deadline: number | null };
  decisionId?: string | null; nonce?: number; sdk?: { language: string; version: string } };

export function runtimeClient(options: { baseUrl: string; token: string; fetch?: typeof fetch; timeoutMs?: number }) {
  const base = new URL(options.baseUrl);
  if (base.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(base.hostname)) throw new FlurboError('invalid_input', 'Use HTTPS for the Flurbo API.');
  if (!/^fla1_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/.test(options.token)) throw new FlurboError('unauthenticated', 'The agent credential is missing or malformed.');
  const request = options.fetch ?? scheduledFetch, timeoutMs = options.timeoutMs ?? 20_000;
  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await request(new URL(RUNTIME_API_BASE + path, base).href, { method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${options.token}`, [PROTOCOL_HEADER]: PROTOCOL_VERSION, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body) });
    } catch { throw new RuntimeApiError('NETWORK', 'The Flurbo API could not be reached.', null, null); }
    let parsed: any = null;
    try { parsed = await response.json(); } catch { parsed = null; }
    if (!response.ok) {
      const retry = Number(response.headers.get('Retry-After'));
      const code = typeof parsed?.code === 'string' ? parsed.code : 'UNAVAILABLE';
      const message = typeof parsed?.error === 'string' && parsed.error.length < 300 ? parsed.error : 'The Flurbo API refused the request.';
      throw new RuntimeApiError(code, message, response.status, Number.isFinite(retry) && retry > 0 ? retry : null);
    }
    return parsed as T;
  }
  return {
    session: () => call<any>('GET', '/session'),
    async deployments(): Promise<Deployment[]> {
      const r = await call<any>('GET', '/deployments');
      if (r?.schema !== 'flurbo.agent-deployments.v1' || !Array.isArray(r.deployments)) throw new FlurboError('invalid_response', 'Unexpected deployments response.');
      return r.deployments.map(parseDeployment);
    },
    market: (namespace: string) => call<any>('GET', `/markets/${encodeURIComponent(namespace)}`),
    validateTrade: (namespace: string, input: { scope: number; mask: string; quantityAtoms: string }) => call<any>('POST', `/markets/${encodeURIComponent(namespace)}/validate-trade`, input),
    quote: (namespace: string, input: { side: 'buy' | 'sell'; scope: number; mask: string; quantityAtoms: string }) => call<any>('POST', `/markets/${encodeURIComponent(namespace)}/quote`, input),
    pairAnalytics: (namespace: string, a: number, b: number) => call<any>('POST', `/markets/${encodeURIComponent(namespace)}/pair-analytics`, { a, b }),
    claimAnalytics: (namespace: string, scope: number, mask: string) => call<any>('POST', `/markets/${encodeURIComponent(namespace)}/claim-analytics`, { scope, mask }),
    wallet: (namespace: string, claims: { scope: number; mask: string }[]) => call<any>('POST', `/markets/${encodeURIComponent(namespace)}/wallet`, { claims }),
    policy: () => call<RuntimePolicy>('GET', '/policy'),
    heartbeat: (beat: Heartbeat) => call<RuntimePolicy>('POST', '/heartbeat', beat),
    decision: (decision: unknown) => call<any>('POST', '/decisions', decision),
    reportExecution: (report: ExecutionReport) => call<any>('POST', '/executions', report),
    execution: (hash: string) => call<any>('GET', `/executions/${hash}`),
  };
}
export type RuntimeClient = ReturnType<typeof runtimeClient>;
