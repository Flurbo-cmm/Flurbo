import { createHash, randomUUID } from 'node:crypto';
import { semanticError, semanticsDisabled } from '../semantics.ts';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { FlurboError } from '../errors.ts';
import { SCHEMAS } from '../version.ts';
import { claimKey, type Claim } from '../claims.ts';
import { covers } from '../distribution.ts';
import { forecastToJSON, type Forecast } from '../forecast.ts';
import { parsePairAnalytics, type Market, type PairImplied, type QuoteResult } from '../market.ts';
import { effectivePolicy, type PolicyConfig, type FlurboPolicy } from '../policy.ts';
import { STRATEGY, candidateClaims, decide, assertConfig, type StrategyConfig, type Decision } from '../strategy.ts';
import type { Deployment } from '../protocol.ts';
import type { ResearchQuestion, EvidenceRequirement } from '../research.ts';
import { chainReader, type ChainReader, type Block } from './chain.ts';
import { executor, type Executor, type ExecutionResult } from './executor.ts';
import { runtimeClient, RuntimeApiError, type RuntimeClient, type RuntimePolicy } from './headless.ts';
import { FileJournal, isFinal } from './journal.ts';
import { jsonRpc } from './rpc.ts';
import { signerFromEnv, type Signer } from './signer.ts';
import { researcher as makeResearcher, httpRetriever, openAiCompatible, anthropicMessages, fixtureForecaster, ProviderError, type Forecaster, type Retriever } from './research.ts';

export const SDK_RUNTIME_VERSION = '0.2.0';

// Operator configuration. Secrets are never in this file, only the names of environment variables.
export type AgentConfig = {
  schema: 'flurbo.agent-config.v1';
  api: { baseUrl: string; credentialEnv: string };
  chain: { rpcUrl: string };
  signer: { kind: 'local-key'; keyEnv: string };
  stateDir: string; mode: 'paper' | 'live'; markets: string[];
  schedule: { intervalSeconds: number; heartbeatSeconds: number; waitSeconds: number };
  research: {
    retriever: { kind: 'http'; allowHosts: string[]; allowLocalHttp?: boolean; extraSources?: Record<string, { event: number; url: string }[]> };
    provider: { kind: 'openai-compatible'; baseUrl: string; model: string; apiKeyEnv: string | null; timeoutMs?: number; maxRetries?: number }
      | { kind: 'anthropic'; model: string; apiKeyEnv: string; timeoutMs?: number; maxRetries?: number }
      // A fixed reply read from a file, for offline runs and demonstrations. Always reported as a fixture, not AI.
      | { kind: 'fixture'; replyFile: string } | { kind: 'none' };
    perCycle: number; perHour: number; maxEvidenceAgeDays: number;
    evidenceRequirements?: Record<string, EvidenceRequirement[]>;
  };
  strategy: { id: 'joint-edge'; quantityAtoms: string; slippageBps: 10 | 50 | 100; minEdgeBps: number; minEdgeAtoms: string; maxCostAtoms: string; includeSingles: boolean; minEvidence: number };
  policy: PolicyConfig; policyMaxAgeSeconds: number; paperBudgetAtoms: string;
};

export function defaultConfig(): AgentConfig {
  return {
    schema: 'flurbo.agent-config.v1',
    api: { baseUrl: 'https://flurbo.singu.online', credentialEnv: 'FLURBO_AGENT_TOKEN' },
    chain: { rpcUrl: 'https://testnet-rpc.monad.xyz' },
    signer: { kind: 'local-key', keyEnv: 'FLURBO_AGENT_PRIVATE_KEY' },
    stateDir: '.flurbo-agent', mode: 'paper', markets: ['pilot'],
    schedule: { intervalSeconds: 300, heartbeatSeconds: 30, waitSeconds: 90 },
    research: { retriever: { kind: 'http', allowHosts: ['github.com'] }, provider: { kind: 'none' }, perCycle: 2, perHour: 20, maxEvidenceAgeDays: 14 },
    strategy: { id: 'joint-edge', quantityAtoms: '1000000', slippageBps: 50, minEdgeBps: 500, minEdgeAtoms: '10000', maxCostAtoms: '2000000', includeSingles: true, minEvidence: 1 },
    policy: { markets: ['pilot'], maxQuantityAtoms: '2000000', maxTradeCostAtoms: '2000000', maxSlippageBps: 50,
      spend: { totalAtoms: '20000000', windows: [{ seconds: 86_400, atoms: '10000000' }] }, maxPositionAtoms: '5000000', maxWorstCaseLossAtoms: '10000000',
      gas: { maxFeeWei: '100000000000000000', reserveWei: '200000000000000000' }, quoteMaxAgeSeconds: 30, minSecondsBeforeClose: 120, maxPending: 2, allowSell: false, allowRedeem: false },
    policyMaxAgeSeconds: 120, paperBudgetAtoms: '50000000',
  };
}

export function parseConfig(value: unknown): AgentConfig {
  const c = value as AgentConfig, bad = (m: string): never => { throw new FlurboError('invalid_input', `Configuration: ${m}`); };
  if (!c || c.schema !== 'flurbo.agent-config.v1') bad('schema must be flurbo.agent-config.v1.');
  if (!['paper', 'live'].includes(c.mode)) bad('mode must be paper or live.');
  if (!Array.isArray(c.markets) || !c.markets.length) bad('list at least one market.');
  if (!c.policy.markets.every(m => c.markets.includes(m))) bad('policy.markets must be a subset of markets.');
  if (![10, 50, 100].includes(c.policy.maxSlippageBps) || c.strategy.slippageBps > c.policy.maxSlippageBps) bad('slippage must be 10, 50 or 100 and within the policy.');
  for (const k of ['credentialEnv'] as const) if (!/^[A-Z_][A-Z0-9_]*$/.test(c.api[k])) bad('credentialEnv must name an environment variable.');
  if (!/^[A-Z_][A-Z0-9_]*$/.test(c.signer.keyEnv)) bad('signer.keyEnv must name an environment variable.');
  if (JSON.stringify(c).match(/0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/) && /"privateKey"|"secret"/i.test(JSON.stringify(c))) bad('secrets do not belong in the configuration file.');
  if (c.schedule.intervalSeconds < 10 || c.schedule.heartbeatSeconds < 5) bad('schedule too aggressive.');
  if (c.research.evidenceRequirements !== undefined) {
    if (!c.research.evidenceRequirements || typeof c.research.evidenceRequirements !== 'object' || Array.isArray(c.research.evidenceRequirements)) bad('research.evidenceRequirements must map market namespaces to requirements.');
    for (const [namespace, requirements] of Object.entries(c.research.evidenceRequirements)) {
      if (!c.markets.includes(namespace) || !Array.isArray(requirements) || requirements.some(r => !r || !Number.isSafeInteger(r.event) || r.event < 0 || r.event > 3
        || !['release', 'background'].includes(r.freshness)) || new Set(requirements.map(r => r.event)).size !== requirements.length) bad('invalid or duplicate evidence requirement.');
    }
  }
  assertConfig(strategyConfig(c));
  return c;
}
export const strategyConfig = (c: AgentConfig): StrategyConfig => ({ quantityAtoms: BigInt(c.strategy.quantityAtoms), slippageBps: c.strategy.slippageBps, minEdgeBps: c.strategy.minEdgeBps,
  minEdgeAtoms: BigInt(c.strategy.minEdgeAtoms), maxCostAtoms: BigInt(c.strategy.maxCostAtoms), minEvidence: c.strategy.minEvidence,
  maxEvidenceAgeDays: c.research.maxEvidenceAgeDays, includeSingles: c.strategy.includeSingles });

// Strategies. A strategy sees the market, a validated forecast and a quote function that reads the pool
// contract at one pinned block. It returns a decision; it never builds, signs or sends a transaction.
export type StrategyContext = { market: Market; forecast: Forecast; now: number; implied: PairImplied | null; quote: (claims: Claim[], quantityAtoms: bigint) => Promise<Map<string, QuoteResult>> };
export type StrategyDecision = {
  outcome: 'propose' | 'abstain'; reasons: string[]; explanation: string;
  proposal: null | { claim: Claim; quantityAtoms: bigint; quoteAtoms: bigint; slippageBps: 10 | 50 | 100; expectedPayoutAtoms?: bigint; edgeAtoms?: bigint; edgeBps?: number };
  detail?: unknown;
};
export interface Strategy { readonly id: string; readonly version: string; decide(ctx: StrategyContext): Promise<StrategyDecision> }

// The reference strategy: compare the joint forecast with executable quotes for single answers and
// combinations of each pair, including the full slippage allowance.
export function jointEdgeStrategy(config: StrategyConfig): Strategy {
  return {
    id: STRATEGY.id, version: STRATEGY.version,
    async decide(ctx) {
      const claims = candidateClaims(ctx.market, ctx.forecast, config).filter(c => covers(ctx.forecast.joint, c));
      const quotes = claims.length ? await ctx.quote(claims, config.quantityAtoms) : new Map<string, QuoteResult>();
      const d: Decision = decide({ market: ctx.market, forecast: ctx.forecast, config, now: ctx.now, quotes, implied: ctx.implied });
      return { outcome: d.outcome, reasons: d.reasons, explanation: d.explanation, detail: { relationship: d.relationship, assumptions: d.assumptions },
        proposal: d.proposal && { claim: d.proposal.claim, quantityAtoms: d.proposal.quantityAtoms, quoteAtoms: d.proposal.quoteAtoms, slippageBps: d.proposal.slippageBps as 10,
          expectedPayoutAtoms: d.proposal.expectedPayoutAtoms, edgeAtoms: d.proposal.edgeAtoms, edgeBps: d.proposal.edgeBps } };
    },
  };
}

// Paper trades: priced at the quote for the quantity at the decision's block, no market impact, strictly
// newer block per claim, and a paper budget. No signer is involved.
type PaperFillRecord = { id: string; decisionId: string; namespace: string; claim: { scope: number; mask: string }; quantityAtoms: string; costAtoms: string; snapshotBlock: string; filledAt: number };
function paperBook(dir: string, journal: FileJournal, budgetAtoms: bigint) {
  const file = join(dir, 'paper.json');
  const read = (): PaperFillRecord[] => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).fills : []);
  return {
    read,
    fill: (f: Omit<PaperFillRecord, 'id'>) => journal.withLock(() => {
      const fills = read(), key = `${f.claim.scope}:${f.claim.mask}`;
      if (fills.some(x => x.decisionId === f.decisionId)) return { ok: false as const, reason: 'already_filled' };
      if (fills.some(x => `${x.claim.scope}:${x.claim.mask}` === key && x.namespace === f.namespace && BigInt(x.snapshotBlock) >= BigInt(f.snapshotBlock))) return { ok: false as const, reason: 'same_quote_block' };
      if (fills.reduce((s, x) => s + BigInt(x.costAtoms), 0n) + BigInt(f.costAtoms) > budgetAtoms) return { ok: false as const, reason: 'paper_budget' };
      const record = { id: randomUUID(), ...f };
      writeFileSync(file, JSON.stringify({ schema: 'flurbo.agent-paper.v1', model: 'quote-at-snapshot-no-impact-v1', fills: [...fills, record] }, null, 1));
      return { ok: true as const, record };
    }),
  };
}

export type RunnerOptions = {
  config: AgentConfig; env?: Record<string, string | undefined>;
  client?: RuntimeClient; chain?: ChainReader; signer?: Signer | null; retriever?: Retriever; forecaster?: Forecaster; strategy?: Strategy;
  now?: () => number; log?: (event: string, detail?: Record<string, unknown>) => void;
};
export type RuntimeStatus = { state: 'running' | 'paused' | 'blocked' | 'stopping' | 'stopped'; blockedBy: string | null };

export function agentRunner(o: RunnerOptions) {
  const config = o.config, env = o.env ?? process.env, now = o.now ?? (() => Math.floor(Date.now() / 1000));
  const log = o.log ?? ((event, detail) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...detail })));
  mkdirSync(config.stateDir, { recursive: true });
  const runtimeFile = join(config.stateDir, 'runtime.json'), stopFile = join(config.stateDir, 'stop.request'), outboxFile = join(config.stateDir, 'outbox.json');
  const saved = existsSync(runtimeFile) ? JSON.parse(readFileSync(runtimeFile, 'utf8')) : {};
  const runtimeId: string = saved.runtimeId ?? `rt-${randomUUID()}`, startedAt = now();
  const saveRuntime = (extra: Record<string, unknown>) => writeFileSync(runtimeFile, JSON.stringify({ ...saved, runtimeId, startedAt, ...extra }, null, 1));

  const token = env[config.api.credentialEnv];
  const client = o.client ?? (token ? runtimeClient({ baseUrl: config.api.baseUrl, token }) : null);
  const chain = o.chain ?? chainReader(jsonRpc(config.chain.rpcUrl));
  // Paper mode never constructs a signer.
  const signer: Signer | null = config.mode === 'live' ? (o.signer ?? signerFromEnv(config.signer.keyEnv, env)) : null;
  const wallet = signer?.address ?? 'paper';
  const journal = new FileJournal(config.stateDir, signer?.address ?? '0x0000000000000000000000000000000000000000');
  const paper = paperBook(config.stateDir, journal, BigInt(config.paperBudgetAtoms));
  const forecaster: Forecaster | ProviderError = o.forecaster ?? (() => {
    const p = config.research.provider;
    try {
      if (p.kind === 'openai-compatible') return openAiCompatible({ baseUrl: p.baseUrl, model: p.model, apiKey: p.apiKeyEnv ? env[p.apiKeyEnv] ?? null : null, timeoutMs: p.timeoutMs, maxRetries: p.maxRetries });
      if (p.kind === 'anthropic') return anthropicMessages({ model: p.model, apiKey: env[p.apiKeyEnv] ?? null, timeoutMs: p.timeoutMs, maxRetries: p.maxRetries });
      if (p.kind === 'fixture') { const file = resolve(config.stateDir, '..', p.replyFile); return fixtureForecaster(() => readFileSync(file, 'utf8'), `fixture:${basename(file)}`); }
      return new ProviderError('provider_not_configured', 'No research provider is configured. Set research.provider in the configuration.');
    } catch (e) { return e instanceof ProviderError ? e : new ProviderError('provider_not_configured', 'The research provider configuration is invalid.'); }
  })();
  const retriever = o.retriever ?? httpRetriever({ allowHosts: config.research.retriever.allowHosts, allowLocalHttp: config.research.retriever.allowLocalHttp });
  const research = makeResearcher({ retriever, forecaster, maxEvidenceAgeSeconds: config.research.maxEvidenceAgeDays * 86_400, perCycle: config.research.perCycle, perHour: config.research.perHour, now });
  const strategy = o.strategy ?? jointEdgeStrategy(strategyConfig(config));

  let flurbo: FlurboPolicy | null = null, readAt: number | null = null, blockedBy: string | null = null, lastCycleAt: number | null = null, lastErrorCode: string | null = null;
  const verified = new Set<string>();
  const stop = (code: string) => { if (!blockedBy) log('stopped_new_actions', { code }); blockedBy = code; };
  const effective = () => effectivePolicy({ mode: config.mode, maxTradeCostAtoms: config.policy.maxTradeCostAtoms, spend: config.policy.spend }, flurbo, readAt, now(), config.policyMaxAgeSeconds);
  const liveAllowed = () => {
    if (blockedBy) return { allowed: false, reason: blockedBy };
    if (existsSync(stopFile)) return { allowed: false, reason: 'stop_requested' };
    const e = effective();
    return { allowed: e.liveAllowed, reason: e.reason };
  };
  const policyNow = (): PolicyConfig => { const e = effective(); return { ...config.policy, maxTradeCostAtoms: e.maxTradeCostAtoms, spend: { ...config.policy.spend, windows: e.windows } }; };
  const exec: Executor | null = signer ? executor({ chain, signer, journal, client, policy: policyNow, liveAllowed, now, waitSeconds: config.schedule.waitSeconds, log, onStop: stop }) : null;
  const policyHash = () => createHash('sha256').update(JSON.stringify({ mode: config.mode, policy: policyNow(), strategy: config.strategy })).digest('hex');
  // `stopped` is sent once, in the final heartbeat when a run ends, so Flurbo shows the runtime as stopped.
  let stopped = false;
  const state = (): RuntimeStatus => ({ state: stopped ? 'stopped' : existsSync(stopFile) ? 'stopping' : blockedBy ? 'blocked' : flurbo?.paused ? 'paused' : 'running', blockedBy });

  async function api<T>(fn: () => Promise<T>): Promise<T | null> {
    if (!client) return null;
    try { return await fn(); }
    catch (e) {
      if (e instanceof RuntimeApiError) { lastErrorCode = e.apiCode; if (e.stop) stop(e.apiCode); }
      else lastErrorCode = 'UNEXPECTED';
      return null;
    }
  }
  async function heartbeat() {
    const pending = journal.read().entries.filter(e => !isFinal(e)).length;
    const r = await api(() => client!.heartbeat({ runtimeId, sdk: { language: 'typescript', version: SDK_RUNTIME_VERSION }, mode: config.mode, state: state().state,
      policy: { hash: policyHash(), flurboVersion: flurbo?.version ?? null, summary: { maxTradeCostAtoms: policyNow().maxTradeCostAtoms, windows: policyNow().spend.windows, totalAtoms: config.policy.spend.totalAtoms, maxPending: config.policy.maxPending } },
      pending, startedAt, lastCycleAt, lastErrorCode }));
    if (r) accept(r);
  }
  function accept(p: RuntimePolicy) { flurbo = { version: p.version, paused: p.paused, liveEnabled: p.liveEnabled, limits: p.limits }; readAt = now(); }
  async function refreshPolicy() { const p = await api(() => client!.policy()); if (p) accept(p); }

  // Decisions are reported as self-reported records; failed reports wait in a local outbox.
  async function reportDecision(d: Record<string, unknown>) {
    const outbox: unknown[] = existsSync(outboxFile) ? JSON.parse(readFileSync(outboxFile, 'utf8')) : [];
    outbox.push(d);
    const remaining: unknown[] = [];
    for (const item of outbox) if (!remaining.length && await api(() => client!.decision(item)) !== null) continue; else remaining.push(item);
    writeFileSync(outboxFile, JSON.stringify(remaining.slice(-200)));
  }

  function toMarket(namespace: string, deployment: Deployment, detail: any, head: Block, resolved: boolean): Market {
    return { namespace: namespace as Market['namespace'], pool: deployment.pool, rulesHash: deployment.rulesHash, title: String(detail.title ?? ''), closesAt: deployment.closesAt,
      open: !resolved && head.timestamp < deployment.closesAt, resolved,
      events: detail.events.map((e: any) => ({ index: e.index, id: e.id, question: e.question, yesRule: e.yesRule, noRule: e.noRule, observationEndsAt: e.observationEndsAt })),
      snapshot: { chainId: 10143, pool: deployment.pool, blockNumber: head.number, blockHash: head.hash, timestamp: head.timestamp },
      oneShareBuyAtoms: detail.events.map(() => ({ yes: null, no: null })) };
  }

  async function marketCycle(d: Deployment) {
    if (!verified.has(d.namespace + d.codeHashes.pool)) { await chain.verifyDeployment(d); verified.add(d.namespace + d.codeHashes.pool); }
    const detail = await api(() => client!.market(d.namespace));
    if (!detail) return;
    const head = await chain.block(), resolved = await chain.resolved(d.pool), market = toMarket(d.namespace, d, detail, head, resolved);
    if (!market.open) { log('market_closed', { namespace: d.namespace }); return; }
    if (d.closesAt - now() < config.policy.minSecondsBeforeClose) { log('too_close_to_close', { namespace: d.namespace }); return; }
    const events: ResearchQuestion[] = market.events.map(e => ({ index: e.index, question: e.question, yesRule: e.yesRule, noRule: e.noRule, observationEndsAt: e.observationEndsAt }));
    for (let a = 0; a < events.length; a++) for (let b = a + 1; b < events.length; b++) {
      if (blockedBy || existsSync(stopFile)) return;
      const decisionId = `d-${randomUUID()}`, pair = [events[a], events[b]];
      const sources = [...detail.events.filter((e: any) => e.index === a || e.index === b).filter((e: any) => e.source?.referenceUrl).map((e: any) => ({ event: e.index, url: e.source.referenceUrl })),
        ...(config.research.retriever.extraSources?.[d.namespace] ?? []).filter(s => s.event === a || s.event === b)];
      const base = { schema: 'flurbo.agent-runtime-decision.v1', decisionId, namespace: d.namespace, createdAt: now() };
      const found = await research.research({ pool: d.pool, title: market.title, eventCount: market.events.length, events: pair, sources,
        evidenceRequirements: config.research.evidenceRequirements?.[d.namespace] });
      const provenance = found.provenance ?? { kind: 'custom', name: 'unconfigured' };
      if (found.status === 'abstain') {
        log('research_abstained', { namespace: d.namespace, events: [a, b], reason: found.reason });
        await reportDecision({ ...base, outcome: 'abstain', reasons: [found.reason], provenance, summary: found.detail });
        continue;
      }
      let implied: PairImplied | null = null;
      const analytics = await api(() => client!.pairAnalytics(d.namespace, a, b));
      if (analytics) { try { implied = parsePairAnalytics(analytics, d.pool); } catch { implied = null; } }
      const quote = async (claims: Claim[], quantity: bigint) => {
        const out = new Map<string, QuoteResult>();
        for (const claim of claims) {
          const amount = await chain.quote(d.pool, 'buy', claim.scope, claim.mask, quantity, head);
          out.set(claimKey(claim), amount === null || amount <= 0n || amount > quantity ? { status: 'unavailable', reason: 'quote_unavailable', detail: 'The pool did not quote this claim at this size.' }
            : { status: 'ok', quote: { schema: SCHEMAS.quote, claim, side: 'buy', quantityAtoms: quantity, amountAtoms: amount, snapshot: market.snapshot, expiresAt: head.timestamp + 60, source: 'pool.quoteBuy' } });
        }
        return out;
      };
      const decision = await strategy.decide({ market, forecast: found.forecast, now: now(), implied, quote });
      const forecastJson = forecastToJSON(found.forecast);
      if (decision.outcome === 'abstain' || !decision.proposal) {
        log('strategy_abstained', { namespace: d.namespace, events: [a, b], reasons: decision.reasons });
        await reportDecision({ ...base, outcome: 'abstain', reasons: decision.reasons.length ? decision.reasons : ['strategy_abstained'], provenance, forecast: forecastJson, summary: decision.explanation.slice(0, 600) });
        continue;
      }
      const p = decision.proposal;
      if (![10, 50, 100].includes(p.slippageBps)) throw new FlurboError('invalid_input', 'The strategy chose an unsupported slippage.');
      const candidate = { claim: { scope: p.claim.scope, mask: p.claim.mask.toString() }, quantityAtoms: p.quantityAtoms.toString(), quoteAtoms: p.quoteAtoms.toString(), slippageBps: p.slippageBps,
        edgeAtoms: p.edgeAtoms?.toString() ?? null, edgeBps: p.edgeBps ?? null, quoteBlock: head.number.toString() };
      if (config.mode === 'paper') {
        let reason:string|null='SEMANTICS_UNAVAILABLE';
        try { const r=await client!.validateTrade(d.namespace,{...candidate.claim,quantityAtoms:candidate.quantityAtoms}); reason=semanticError(r,{...d,...candidate.claim,quantityAtoms:candidate.quantityAtoms},now()); if(!reason&&semanticsDisabled(r))log('SEMANTICS_DISABLED',{namespace:d.namespace}); } catch {}
        if(reason){log(reason,{namespace:d.namespace});await reportDecision({...base,outcome:'abstain',reasons:[reason],provenance,forecast:forecastJson,candidate,summary:'The purchase did not pass outcome compatibility checks.'});continue;}
        const r = await paper.fill({ decisionId, namespace: d.namespace, claim: candidate.claim, quantityAtoms: candidate.quantityAtoms, costAtoms: candidate.quoteAtoms, snapshotBlock: candidate.quoteBlock, filledAt: now() });
        log(r.ok ? 'paper_trade' : 'paper_skipped', { namespace: d.namespace, claim: candidate.claim, ...(r.ok ? {} : { reason: r.reason }) });
        await reportDecision({ ...base, outcome: r.ok ? 'paper' : 'abstain', reasons: r.ok ? [] : [r.reason], provenance, forecast: forecastJson, candidate, summary: decision.explanation.slice(0, 600) });
        continue;
      }
      await refreshPolicy();
      const result: ExecutionResult = await exec!.execute({ decisionId, deployment: d, action: 'buy', claim: p.claim, quantityAtoms: p.quantityAtoms, slippageBps: p.slippageBps, quoteAtoms: p.quoteAtoms, quoteBlock: head });
      log('execution', { namespace: d.namespace, status: result.status, ...('hash' in result ? { hash: result.hash } : {}), ...('violations' in result ? { violations: result.violations } : {}) });
      await reportDecision({ ...base, outcome: result.status === 'rejected_by_policy' || result.status === 'blocked' ? 'rejected_by_policy' : 'trade',
        reasons: result.status === 'rejected_by_policy' ? result.violations : result.status === 'blocked' ? [result.reason] : [], provenance, forecast: forecastJson, candidate,
        ...('violations' in result ? { violations: result.violations } : {}), ...('hash' in result && result.hash ? { execution: { hash: result.hash, status: result.status } } : {}), summary: decision.explanation.slice(0, 600) });
    }
  }

  async function cycle() {
    research.resetCycle();
    await refreshPolicy();
    await heartbeat();
    if (exec) { await exec.reconcileAll(); await exec.report(); }
    if (!blockedBy && !existsSync(stopFile) && client) {
      const deployments = await api(() => client.deployments());
      for (const d of (deployments ?? []).filter(x => config.markets.includes(x.namespace))) {
        try { await marketCycle(d); }
        catch (e) { lastErrorCode = (e as FlurboError).code ?? 'UNEXPECTED'; log('market_cycle_failed', { namespace: d.namespace, code: lastErrorCode }); }
      }
    }
    lastCycleAt = now(); saveRuntime({ lastCycleAt, blockedBy, lastErrorCode });
    await heartbeat();
  }

  return {
    runtimeId, wallet, cycle, heartbeat, state, journal, paper,
    // Reconciles and reports existing transactions only. Never starts a new action.
    async recover() {
      await refreshPolicy();
      if (!exec) return { reconciled: 0, message: 'Paper mode has no transactions to recover.' };
      const r = await exec.reconcileAll(); await exec.report();
      return { reconciled: r.length, open: journal.read().entries.filter(e => !isFinal(e)).length };
    },
    async run({ once = false } = {}) {
      if (existsSync(stopFile)) unlinkSync(stopFile);
      log('started', { runtimeId, mode: config.mode, wallet, markets: config.markets });
      const beat = setInterval(() => { void heartbeat(); }, config.schedule.heartbeatSeconds * 1000);
      try {
        for (;;) {
          await cycle();
          if (once || existsSync(stopFile)) break;
          const until = Date.now() + config.schedule.intervalSeconds * 1000;
          while (Date.now() < until && !existsSync(stopFile)) await new Promise(r => setTimeout(r, 500));
          if (existsSync(stopFile)) break;
        }
      } finally { clearInterval(beat); }
      // Every ended run tells Flurbo it stopped, whether it was asked to stop or ran once, so the dashboard
      // never shows a finished runtime as running.
      if (existsSync(stopFile)) unlinkSync(stopFile);
      stopped = true; await heartbeat().catch(() => {}); stopped = false;
      log('stopped', { runtimeId });
    },
    requestStop: () => writeFileSync(stopFile, String(now())),
    status() {
      const j = existsSync(join(config.stateDir, 'journal.json')) ? JSON.parse(readFileSync(join(config.stateDir, 'journal.json'), 'utf8')) : { entries: [] };
      return { runtimeId, mode: config.mode, wallet, stopRequested: existsSync(stopFile), locked: existsSync(join(config.stateDir, 'journal.lock')),
        pending: j.entries.filter((e: any) => !['confirmed', 'reverted', 'mismatch', 'replaced', 'expired', 'abandoned'].includes(e.status)).map((e: any) => ({ id: e.id, action: e.action, status: e.status, hash: e.hash })),
        recent: j.entries.slice(-10).map((e: any) => ({ action: e.action, status: e.status, hash: e.hash, costAtoms: e.costAtoms, report: e.report?.flurboStatus })),
        paperFills: paper.read().length, lastCycleAt: saved.lastCycleAt ?? null,
        // A separate process reports what the last run recorded; it does not contact Flurbo.
        state: existsSync(stopFile) ? 'stopping' : saved.blockedBy ? 'blocked' : 'ready', blockedBy: saved.blockedBy ?? null, lastErrorCode: saved.lastErrorCode ?? null };
    },
  };
}
export type AgentRunner = ReturnType<typeof agentRunner>;
