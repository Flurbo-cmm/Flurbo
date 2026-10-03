import { FlurboError } from './errors.ts';
import { SCHEMAS } from './version.ts';
import { type Joint, assertJoint, jointFromJSON, jointToJSON } from './distribution.ts';

// A structured forecast. Everything here is the forecaster's claim about the world, kept separate from
// market-implied values. Evidence and explanations are untrusted text: stored and displayed, never
// executed and never allowed to change wallets, recipients, contracts, budgets or policy.
export type Evidence = { id: string; title: string; source: string; url: string | null; observedAt: string; note: string };
export type ForecastSource = { kind: 'user' | 'fixture' | 'provider'; name: string };
export type Forecast = {
  schema: typeof SCHEMAS.forecast;
  pool: string;
  joint: Joint;
  evidence: Evidence[];
  assumptions: string[];
  uncertainty: string;
  explanation: string;
  // Self-reported by the forecaster. It is not a calibrated confidence and is never displayed as one.
  selfReportedConfidence: 'low' | 'medium' | 'high' | null;
  source: ForecastSource;
  createdAt: string;
};

const text = (value: unknown, max: number, label: string, min = 0): string => {
  if (typeof value !== 'string') throw new FlurboError('invalid_forecast', `${label} must be text.`);
  const trimmed = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (trimmed.length < min || trimmed.length > max) throw new FlurboError('invalid_forecast', `${label} must be ${min} to ${max} characters.`);
  return trimmed;
};
const isoTime = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/.test(value) || Number.isNaN(Date.parse(value)))
    throw new FlurboError('invalid_forecast', `${label} must be an ISO UTC time.`);
  return new Date(Date.parse(value)).toISOString();
};
// Evidence links are recorded for people to open. The SDK never fetches them.
export function evidenceUrl(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 512 || /[\s\u0000-\u001f\u007f]/.test(value)) throw new FlurboError('invalid_forecast', 'Evidence links must be plain HTTPS URLs.');
  let url: { protocol: string; username: string; password: string; hostname: string; href: string };
  try { url = new (globalThis as unknown as { URL: new (v: string) => typeof url }).URL(value); } catch { throw new FlurboError('invalid_forecast', 'Evidence links must be plain HTTPS URLs.'); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.')) throw new FlurboError('invalid_forecast', 'Evidence links must be plain HTTPS URLs.');
  return url.href;
}

export function parseForecast(value: unknown, options: { eventCount: number; pool: string; now?: Date; maxEvidenceAgeDays?: number }): Forecast {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new FlurboError('invalid_forecast', 'Forecast must be an object.');
  if (v.schema !== SCHEMAS.forecast) throw new FlurboError('invalid_forecast', 'Unrecognised forecast schema.');
  if (typeof v.pool !== 'string' || v.pool.toLowerCase() !== options.pool) throw new FlurboError('cross_pool', 'The forecast belongs to a different pool.');
  const joint = jointFromJSON(v.joint, options.eventCount);
  if (!Array.isArray(v.evidence) || v.evidence.length > 12) throw new FlurboError('invalid_forecast', 'Provide at most twelve evidence items.');
  const now = options.now ?? new Date();
  const evidence = v.evidence.map((raw, i): Evidence => {
    const e = raw as Record<string, unknown>;
    if (!e || typeof e !== 'object') throw new FlurboError('invalid_forecast', 'Malformed evidence.');
    const observedAt = isoTime(e.observedAt, 'Evidence time');
    if (Date.parse(observedAt) > now.getTime() + 5 * 60_000) throw new FlurboError('invalid_forecast', 'Evidence cannot be observed in the future.');
    return { id: text(e.id ?? `evidence-${i + 1}`, 64, 'Evidence id', 1), title: text(e.title, 160, 'Evidence title', 3), source: text(e.source, 120, 'Evidence source', 2),
      url: evidenceUrl(e.url), observedAt, note: text(e.note ?? '', 600, 'Evidence note') };
  });
  const assumptions = Array.isArray(v.assumptions) ? v.assumptions.slice(0, 8).map(a => text(a, 300, 'Assumption', 3)) : [];
  if (!Array.isArray(v.assumptions) || v.assumptions.length > 8) throw new FlurboError('invalid_forecast', 'Provide at most eight assumptions.');
  const confidence = v.selfReportedConfidence ?? null;
  if (confidence !== null && !['low', 'medium', 'high'].includes(confidence as string)) throw new FlurboError('invalid_forecast', 'Unknown self-reported confidence.');
  const source = v.source as Record<string, unknown> | null;
  if (!source || !['user', 'fixture', 'provider'].includes(source.kind as string)) throw new FlurboError('invalid_forecast', 'Forecast source is required.');
  return {
    schema: SCHEMAS.forecast, pool: options.pool, joint, evidence, assumptions,
    uncertainty: text(v.uncertainty, 600, 'Uncertainty', 3), explanation: text(v.explanation, 1200, 'Explanation', 10),
    selfReportedConfidence: confidence as Forecast['selfReportedConfidence'],
    source: { kind: source.kind as ForecastSource['kind'], name: text(source.name, 64, 'Source name', 1) },
    createdAt: isoTime(v.createdAt, 'Forecast time'),
  };
}

export const forecastToJSON = (f: Forecast) => ({ ...f, joint: jointToJSON(f.joint) });

// Freshest evidence observation, used for insufficient-evidence checks.
export function evidenceSummary(f: Forecast, now: Date, maxAgeDays: number) {
  const fresh = f.evidence.filter(e => now.getTime() - Date.parse(e.observedAt) <= maxAgeDays * 86_400_000);
  return { total: f.evidence.length, fresh: fresh.length };
}

// Provider-neutral forecasting interface. Providers return raw untrusted JSON; parseForecast decides.
export type ForecastRequest = { pool: string; eventCount: number; events: { index: number; question: string; yesRule: string; noRule: string; observationEndsAt: number }[] };
export type ProviderUsage = { requests: number; limit: number | null; resetsAt: string | null };
export interface ForecastProvider {
  readonly name: string;
  readonly kind: 'fixture' | 'provider';
  forecast(request: ForecastRequest, options?: { signal?: AbortSignal }): Promise<unknown>;
  usage(): ProviderUsage;
}

export type ProviderOutcome = { status: 'ok'; forecast: Forecast } | { status: 'abstain'; reason: 'provider_unavailable' | 'rate_limited' | 'invalid_output' | 'timeout'; detail: string };

// Calls a provider with a timeout and turns every failure into an explicit abstention.
export async function requestForecast(provider: ForecastProvider, request: ForecastRequest, options: { timeoutMs?: number; signal?: AbortSignal; now?: Date } = {}): Promise<ProviderOutcome> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let raw: unknown;
  try { raw = await provider.forecast(request, { signal }); }
  catch (error) {
    if (signal.aborted && timeout.aborted) return { status: 'abstain', reason: 'timeout', detail: 'The forecaster did not respond in time.' };
    if (error instanceof FlurboError && error.code === 'rate_limited') return { status: 'abstain', reason: 'rate_limited', detail: 'The forecaster is rate limited. Try later.' };
    return { status: 'abstain', reason: 'provider_unavailable', detail: 'The forecaster is unavailable.' };
  }
  try { return { status: 'ok', forecast: parseForecast(raw, { eventCount: request.eventCount, pool: request.pool, now: options.now }) }; }
  catch { return { status: 'abstain', reason: 'invalid_output', detail: 'The forecaster returned output that failed validation.' }; }
}

// Deterministic offline provider for research and tests. It returns stored fixtures, clearly labelled.
export function fixtureProvider(fixtures: Record<string, unknown>, name = 'offline-fixture'): ForecastProvider {
  let requests = 0;
  return {
    name, kind: 'fixture',
    async forecast(request) {
      requests++;
      const key = `${request.pool}:${request.events.map(e => e.index).join(',')}`;
      if (!(key in fixtures)) throw new FlurboError('provider_unavailable', 'No fixture forecast for these events.');
      return structuredClone(fixtures[key]);
    },
    usage: () => ({ requests, limit: null, resetsAt: null }),
  };
}

export function makeForecast(input: Omit<Forecast, 'schema' | 'joint'> & { joint: Joint }): Forecast {
  assertJoint(input.joint);
  return { schema: SCHEMAS.forecast, ...input };
}
