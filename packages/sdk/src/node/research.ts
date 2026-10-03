import { createHash } from 'node:crypto';
import { FlurboError } from '../errors.ts';
import { EVIDENCE_SCHEMA, buildResearchPrompt, forecastFromModel, validateModelOutput, isCitableEvidence, evidenceFailure, type EvidenceRecord, type EvidenceRequirement, type ResearchAbstain, type ResearchQuestion } from '../research.ts';
import type { Forecast } from '../forecast.ts';

// Research on the operator's machine (protocol/specs/research.md). Retrieval is explicit and allowlisted;
// retrieved text is untrusted data; the model has no tools and never sees keys or wallet details; every
// output is validated; every failure is an abstention with a reason.

export type RetrievalSource = { event: number; url: string };
export interface Retriever { readonly name: string; retrieve(sources: RetrievalSource[], now: number): Promise<EvidenceRecord[]> }

// Fetches allowlisted HTTPS pages (by default the source each market publishes for its events).
// allowLocalHttp permits plain HTTP to this machine only (local test evidence); never remote plain HTTP.
export function httpRetriever(options: { allowHosts: string[]; allowLocalHttp?: boolean; maxBytes?: number; timeoutMs?: number; maxSources?: number; fetch?: typeof fetch }): Retriever {
  const allow = new Set(options.allowHosts.map(h => h.toLowerCase())), request = options.fetch ?? fetch;
  const maxBytes = options.maxBytes ?? 2_000_000, timeoutMs = options.timeoutMs ?? 10_000;
  const allowed = (u: URL) => !u.username && !u.password && ((u.protocol === 'https:' && allow.has(u.hostname.toLowerCase()))
    || (!!options.allowLocalHttp && u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname)));
  async function get(url: string): Promise<{ response: Response; finalUrl: string }> {
    let current = new URL(url);
    for (let hop = 0; hop < 4; hop++) {
      if (!allowed(current)) throw new FlurboError('forbidden', 'Source host not allowlisted.');
      const r = await request(current.href, { redirect: 'manual', headers: { Accept: 'text/html,application/json,text/plain' }, signal: AbortSignal.timeout(timeoutMs) });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { await r.body?.cancel(); current = new URL(r.headers.get('location')!, current); continue; }
      return { response: r, finalUrl: current.href };
    }
    throw new FlurboError('invalid_response', 'Too many redirects.');
  }
  return {
    name: 'http',
    async retrieve(sources, now) {
      const out: EvidenceRecord[] = [];
      for (const source of sources.slice(0, options.maxSources ?? 6)) {
        try {
          if (!Number.isSafeInteger(source.event) || source.event < 0) continue;
          const { response: r, finalUrl } = await get(source.url);
          const type = r.headers.get('content-type') ?? '';
          if (!r.ok || r.status === 206 || r.headers.has('content-range') || !/text\/|application\/(json|xhtml)/.test(type) || !r.body) { await r.body?.cancel(); continue; }
          const reader = r.body.getReader(), chunks: Uint8Array[] = [];
          let size = 0, complete = false;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) { complete = true; break; }
              size += value.length;
              if (size > maxBytes) { await reader.cancel(); break; }
              chunks.push(value);
            }
          } finally { reader.releaseLock(); }
          if (!complete || size === 0) continue;
          const raw = Buffer.concat(chunks), text = extractText(raw.toString('utf8'), type);
          if (!text) continue;
          const modified = Date.parse(r.headers.get('last-modified') ?? '');
          out.push({ schema: EVIDENCE_SCHEMA, id: `src-${out.length + 1}`, url: finalUrl, requestedUrl: source.url, finalUrl,
            title: titleOf(raw.toString('utf8')) ?? finalUrl, publisher: new URL(finalUrl).host,
            retrievedAt: now, publisherReleasedAt: null, httpLastModified: Number.isFinite(modified) && modified >= 0 ? Math.floor(modified / 1000) : null,
            completeDocument: true, capturedBytes: size, eventIds: [source.event], contentSha256: createHash('sha256').update(raw).digest('hex'), excerpt: text.slice(0, 4000) });
        } catch { /* A failed source is skipped; research abstains if nothing usable remains. */ }
      }
      return out;
    },
  };
}
const titleOf = (html: string) => /<title[^>]*>([^<]{1,160})<\/title>/i.exec(html)?.[1]?.trim() ?? null;
export function extractText(body: string, type = 'text/html'): string {
  if (!/html/.test(type)) return body.replace(/\s+/g, ' ').trim();
  return body.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

// Deterministic evidence for offline tests and examples. Labelled as fixture evidence.
export function fixtureRetriever(records: Omit<EvidenceRecord, 'retrievedAt'>[]): Retriever {
  return { name: 'fixture', retrieve: async (_sources, now) => records.map(r => ({ ...r, retrievedAt: now })) };
}

export type Prompt = { system: string; user: string };
export interface Forecaster { readonly kind: 'model' | 'fixture' | 'custom'; readonly name: string; complete(prompt: Prompt): Promise<string> }
export class ProviderError extends FlurboError {
  readonly reason: ResearchAbstain;
  constructor(reason: ResearchAbstain, message: string) { super(reason === 'rate_limited' ? 'rate_limited' : reason === 'timeout' ? 'timeout' : 'provider_unavailable', message); this.reason = reason; }
}

// Calls with a timeout and a bounded number of retries for transport errors, 429 and 5xx only. Provider
// error bodies are never surfaced (they can echo keys or prompts).
async function post(url: string, headers: Record<string, string>, body: unknown, o: { timeoutMs: number; maxRetries: number; fetch: typeof fetch }): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try { response = await o.fetch(url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(o.timeoutMs) }); }
    catch (e) {
      if (attempt < o.maxRetries) { await new Promise(r => setTimeout(r, 500 * 2 ** attempt)); continue; }
      throw new ProviderError((e as Error)?.name === 'TimeoutError' ? 'timeout' : 'provider_unavailable', 'The model provider could not be reached.');
    }
    if (response.ok) return response.json();
    if ((response.status === 429 || response.status >= 500) && attempt < o.maxRetries) {
      const wait = Math.min(Number(response.headers.get('retry-after')) || 2 ** attempt, 10);
      await new Promise(r => setTimeout(r, wait * 1000)); continue;
    }
    throw new ProviderError(response.status === 429 ? 'rate_limited' : 'provider_unavailable', `The model provider refused the request (HTTP ${response.status}).`);
  }
}

// Any service that implements the OpenAI chat completions API (hosted providers, or a local model server).
export function openAiCompatible(o: { baseUrl: string; model: string; apiKey: string | null; timeoutMs?: number; maxRetries?: number; fetch?: typeof fetch; name?: string }): Forecaster {
  const base = new URL(o.baseUrl);
  const local = ['127.0.0.1', 'localhost'].includes(base.hostname);
  if (base.protocol !== 'https:' && !local) throw new FlurboError('invalid_input', 'Use HTTPS for a remote model provider.');
  if (!o.apiKey && !local) throw new ProviderError('provider_not_configured', 'No API key configured for the model provider.');
  return {
    kind: 'model', name: o.name ?? `${base.hostname}/${o.model}`,
    async complete(prompt) {
      const r = await post(new URL('chat/completions', base.href.endsWith('/') ? base.href : base.href + '/').href, o.apiKey ? { Authorization: `Bearer ${o.apiKey}` } : {},
        { model: o.model, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }] },
        { timeoutMs: o.timeoutMs ?? 60_000, maxRetries: Math.min(o.maxRetries ?? 2, 3), fetch: o.fetch ?? fetch });
      const content = r?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new ProviderError('malformed_output', 'The model returned no text.');
      return content;
    },
  };
}

export function anthropicMessages(o: { model: string; apiKey: string | null; baseUrl?: string; maxTokens?: number; timeoutMs?: number; maxRetries?: number; fetch?: typeof fetch }): Forecaster {
  if (!o.apiKey) throw new ProviderError('provider_not_configured', 'No API key configured for the model provider.');
  const base = new URL(o.baseUrl ?? 'https://api.anthropic.com/');
  return {
    kind: 'model', name: `anthropic/${o.model}`,
    async complete(prompt) {
      const r = await post(new URL('v1/messages', base).href, { 'x-api-key': o.apiKey!, 'anthropic-version': '2023-06-01' },
        { model: o.model, max_tokens: o.maxTokens ?? 1500, temperature: 0, system: prompt.system, messages: [{ role: 'user', content: prompt.user }] },
        { timeoutMs: o.timeoutMs ?? 60_000, maxRetries: Math.min(o.maxRetries ?? 2, 3), fetch: o.fetch ?? fetch });
      const text = Array.isArray(r?.content) ? r.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('') : null;
      if (typeof text !== 'string' || !text) throw new ProviderError('malformed_output', 'The model returned no text.');
      return text;
    },
  };
}

// A fixed reply, for offline tests and examples. Always reported as a fixture, never as a model.
export function fixtureForecaster(reply: (prompt: Prompt) => string, name = 'offline-fixture'): Forecaster {
  return { kind: 'fixture', name, complete: async prompt => reply(prompt) };
}

export type ResearchResult =
  | { status: 'ok'; forecast: Forecast; evidence: EvidenceRecord[]; provenance: { kind: 'model' | 'fixture' | 'custom'; name: string } }
  | { status: 'abstain'; reason: ResearchAbstain; detail: string; modelReason?: string; evidence: EvidenceRecord[]; provenance: { kind: 'model' | 'fixture' | 'custom'; name: string } | null };

// Request budgets: per cycle (reset by the runner) and per rolling hour, counted in this process.
export function researcher(o: { retriever: Retriever; forecaster: Forecaster | ProviderError; maxEvidenceAgeSeconds: number; perCycle: number; perHour: number; now?: () => number }) {
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));
  let cycleCount = 0; const hour: number[] = [];
  return {
    resetCycle() { cycleCount = 0; },
    async research(input: { pool: string; title: string; eventCount: number; events: ResearchQuestion[]; sources: RetrievalSource[]; evidenceRequirements?: EvidenceRequirement[] }): Promise<ResearchResult> {
      const t = now();
      if (o.forecaster instanceof ProviderError) return { status: 'abstain', reason: o.forecaster.reason, detail: o.forecaster.message, evidence: [], provenance: null };
      const provenance = { kind: o.forecaster.kind, name: o.forecaster.name };
      while (hour.length && hour[0] <= t - 3600) hour.shift();
      if (cycleCount >= o.perCycle || hour.length >= o.perHour) return { status: 'abstain', reason: 'request_budget_exhausted', detail: 'The research request budget is used up.', evidence: [], provenance };
      const evidence = await o.retriever.retrieve(input.sources, t);
      if (!evidence.length) return { status: 'abstain', reason: 'no_sources', detail: 'No evidence could be retrieved from the allowed sources.', evidence, provenance };
      const context = { requestedEvents: input.events.map(e => e.index), eventCount: input.eventCount, evidence, now: t,
        maxEvidenceAgeSeconds: o.maxEvidenceAgeSeconds, evidenceRequirements: input.evidenceRequirements };
      const usable = evidence.filter(e => isCitableEvidence(e, t, input.eventCount));
      const failure = usable.length ? evidenceFailure(usable, context) : 'invalid_evidence';
      if (failure) return { status: 'abstain', reason: failure, detail: `Evidence requirements failed: ${failure}.`, evidence, provenance };
      cycleCount++; hour.push(t);
      let reply: string;
      try { reply = await o.forecaster.complete(buildResearchPrompt({ ...input, evidence: usable, now: t })); }
      catch (e) { const pe = e instanceof ProviderError ? e : new ProviderError('provider_unavailable', 'The model provider failed.'); return { status: 'abstain', reason: pe.reason, detail: pe.message, evidence, provenance }; }
      const outcome = validateModelOutput(reply, context);
      if (outcome.status === 'abstain') return { status: 'abstain', reason: outcome.reason, detail: `The forecast was not used: ${outcome.reason}.`, modelReason: outcome.modelReason, evidence, provenance };
      try {
        const forecast = forecastFromModel(outcome.output, { pool: input.pool, eventCount: input.eventCount, evidence, provider: provenance.kind === 'fixture' ? 'fixture' : provenance.name.split('/')[0], model: provenance.name.split('/').slice(1).join('/') || provenance.name, now: t, evidenceRequirements: input.evidenceRequirements });
        return { status: 'ok', forecast: provenance.kind === 'fixture' ? { ...forecast, source: { kind: 'fixture', name: provenance.name } } : forecast, evidence, provenance };
      } catch { return { status: 'abstain', reason: 'malformed_output', detail: 'The forecast failed final validation.', evidence, provenance }; }
    },
  };
}
