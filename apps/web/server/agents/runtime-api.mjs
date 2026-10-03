import {CapacityError} from '../request-limits.mjs';
import { settlementSources } from '../../shared/settlement-sources.mjs';
import { randomBytes } from 'node:crypto';
import { assessSemantics } from '../semantic-validation.mjs';
import { verifyMessage, encodeFunctionData, decodeFunctionResult } from 'viem';
import { pilotCash, pilotCashAbi, validClaim } from '../../shared/pilot.mjs';
import { quoteClaims, readResolution } from './agent-market.mjs';
import { authenticate, newCredential, publicCredential, credentialStatus, RuntimeError, DEFAULT_TTL_DAYS } from './credentials.mjs';
import { parseIntent, verifyExecution } from './executions.mjs';
import { FINAL_EXECUTION, AGENT_LIMITS } from './agent-store.mjs';
import { PROTOCOL_VERSION, SCOPES, parseForecast, FlurboError, isNamespace } from '../../../../packages/sdk/src/index.ts';

// Headless agent runtime API (protocol/openapi/agent-runtime.v1.yaml). Called only with an agent credential:
// cookies are never read here, and browsers are refused so tokens stay out of web pages. Nothing here signs
// or sends a transaction; runtimes sign with their own keys and report what they sent.
const RATE_PER_MINUTE = 120, SERVICE_PER_MINUTE = 1200, HEARTBEAT_ONLINE = 90, HEARTBEAT_STALE = 600, HEARTBEAT_PERSIST_SECONDS = 300;
const fail = (status, code, message) => { throw new RuntimeError(status, code, message); };
const exact = (v, keys, optional = []) => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k) && !optional.includes(k)) || keys.some(k => !(k in v))) fail(400, 'INVALID_INPUT', 'Unexpected request fields.');
  return v;
};
const HASH = /^0x[0-9a-f]{64}$/;

export function deploymentOf(namespace, svc) {
  const m = svc.manifest;
  return { schema: 'flurbo.agent-deployment.v1', interface: 'flurbo.pilot-pool.v1', namespace, chainId: 10143, pool: m.pool, resolver: m.resolver,
    collateral: { address: pilotCash, decimals: 6 }, codeHashes: { pool: m.codeHashes[m.pool], resolver: m.codeHashes[m.resolver] }, rulesHash: m.rulesHash,
    closesAt: m.publication.draft.closesAt, eventCount: m.publication.draft.events.length,
    limits: { maxQuantityAtoms: '100000000', maxLimitAtoms: '100000000', slippageBps: [10, 50, 100], maxDeadlineSeconds: 300 } };
}

// Flurbo's default live-trading limits match the runtimes' own local defaults (agent-config maxTradeCostAtoms and
// spend.windows): 2 test AUSD per trade, 10 test AUSD per 24 hours. They are published on the Docs page.
export const DEFAULT_LIVE_LIMITS = Object.freeze({ maxTradeCostAtoms: '2000000', windows: Object.freeze([Object.freeze({ seconds: 86_400, atoms: '10000000' })]) });
const defaultLimits = () => ({ maxTradeCostAtoms: DEFAULT_LIVE_LIMITS.maxTradeCostAtoms, windows: DEFAULT_LIVE_LIMITS.windows.map(w => ({ ...w })) });
export const defaultRuntimePolicy = () => ({ version: 1, paused: false, liveEnabled: false, limits: defaultLimits() });
export const policyView = (profile, now) => ({ schema: 'flurbo.agent-runtime-policy.v1', ...profile.runtimePolicy, markets: profile.markets, serverTime: now });

// Dashboard connection state from the latest heartbeat. Pause is separate: it is an instruction.
export function connection(heartbeats, now) {
  const latest = [...(heartbeats ?? [])].sort((a, b) => b.receivedAt - a.receivedAt)[0];
  if (!latest) return { state: 'never', latest: null };
  const age = now - latest.receivedAt;
  // A runtime that reported its own stop is stopped, however recent that report is.
  if (latest.state === 'stopped') return { state: 'stopped', ageSeconds: age, latest };
  return { state: age <= HEARTBEAT_ONLINE ? 'connected' : age <= HEARTBEAT_STALE ? 'stale' : 'disconnected', ageSeconds: age, latest };
}

// Accounting from verified executions only.
function account(totals, action, status, collateral) {
  const add = (field, v) => { totals[field] = (BigInt(totals[field]) + BigInt(v ?? '0')).toString(); };
  if (status === 'confirmed') {
    if (action === 'buy') { totals.buys++; add('buyCostAtoms', collateral); }
    else if (action === 'sell') { totals.sells++; add('sellProceedsAtoms', collateral); }
    else if (action === 'redeem') { totals.redemptions++; add('redeemedAtoms', collateral); }
    else totals.approvals++;
  } else if (status === 'reverted') totals.reverted++;
  else if (status === 'mismatch') totals.mismatched++;
  else if (status === 'attributed-elsewhere') totals.attributedElsewhere++;
}

// `count` replaces the shared Redis rate windows with another counter (in memory on a single server).
export function runtimeApi({ store, serviceFor, rpc, now, previewAllows = null, reservedWallets = new Set(), links = null, count = null }) {
  const bump = count ?? ((key, seconds) => store.count(key, seconds));
  // Heartbeats arrive every 30 seconds per runtime, and writing each one cost about nine Redis commands. The
  // latest beat per runtime is kept in this process and shown on the dashboard straight away; it is written to
  // Redis only when something a person would see changes (mode, state, pending count, SDK, policy, credential,
  // last error, a new run) or when the stored one is HEARTBEAT_PERSIST_SECONDS old. After a restart the stored
  // beat is at most that old, which the dashboard shows as "stale" rather than "running" until the next beat.
  const live = new Map(), written = new Map();
  const material = b => JSON.stringify([b.mode, b.state, b.pending, b.sdk, b.policy.hash, b.policy.flurboVersion, b.credentialId, b.lastErrorCode, b.startedAt]);
  const agentKey = (acct, id) => `${acct.toLowerCase()}:${id}`;
  function remember(acct, id, beat) {
    if (live.size >= 5000) for (const [k, beats] of live) if ([...beats.values()].every(b => now() - b.receivedAt > HEARTBEAT_STALE)) { live.delete(k); for (const r of beats.keys()) written.delete(k + ':' + r); }
    const k = agentKey(acct, id), beats = live.get(k) ?? new Map();
    beats.set(beat.runtimeId, beat); live.set(k, beats);
  }
  // Stored heartbeats merged with the newer ones held here, newest first, as the dashboard expects.
  function heartbeatsFor(acct, id, stored = []) {
    const merged = new Map(stored.map(b => [b.runtimeId, b]));
    for (const b of live.get(agentKey(acct, id))?.values() ?? []) if (!merged.has(b.runtimeId) || merged.get(b.runtimeId).receivedAt < b.receivedAt) merged.set(b.runtimeId, b);
    return [...merged.values()].sort((a, b) => b.receivedAt - a.receivedAt).slice(0, AGENT_LIMITS.heartbeats);
  }
  const service = namespace => {
    const svc = isNamespace(namespace) ? serviceFor(namespace) : null;
    return svc ?? fail(404, 'NOT_FOUND', 'That market is not available.');
  };

  // Verify one reported execution and, if it is this agent's, claim ownership atomically with accounting.
  async function checkExecution(account_, agentId, hash) {
    const found = await store.get(account_, agentId);
    if (!found) fail(404, 'NOT_FOUND', 'Agent not found.');
    const record = found.state.runtime.executions.find(e => e.hash === hash);
    if (!record) fail(404, 'NOT_FOUND', 'Execution not reported.');
    if (FINAL_EXECUTION.includes(record.status)) return record;
    const svc = service(record.namespace);
    let result;
    try { result = await verifyExecution({ rpc, manifest: svc.manifest, walletHistory: found.profile.walletHistory, hash, intent: record.intent }); }
    catch { return record; } // RPC trouble: stays unverified; checked again later.
    return store.mutate(account_, agentId, async (state, _profile, own) => {
      const r = state.runtime.executions.find(e => e.hash === hash);
      if (!r || FINAL_EXECUTION.includes(r.status)) return r;
      r.checkedAt = now();
      if (['unknown', 'pending', 'confirming'].includes(result.status)) { r.status = result.status === 'unknown' ? 'recorded' : 'pending'; return r; }
      let status = result.status;
      if (status === 'confirmed' || status === 'reverted') {
        const owner = await own.read(hash), recordId = `execution:${hash}`;
        if (owner && !own.owns(owner, recordId, result.digest)) status = 'attributed-elsewhere';
        else own.claim(hash, recordId, result.digest);
      }
      Object.assign(r, { status, verification: { reason: result.reason ?? null, blockNumber: result.blockNumber ?? null, blockTimestamp: result.blockTimestamp ?? null,
        from: result.from ?? null, collateralAtoms: status === 'confirmed' ? result.collateralAtoms ?? null : null, gasUsed: result.gasUsed ?? null, effectiveGasPrice: result.effectiveGasPrice ?? null } });
      account(state.runtime.totals, r.intent.action, status, r.verification.collateralAtoms);
      return r;
    });
  }

  // Session side (dashboard): credentials, wallet association, runtime policy.
  const session = {
    async issueCredential(login, agentId, input) {
      exact(input, ['scopes'], ['ttlDays', 'label']);
      const found = await store.get(login, agentId);
      if (!found || found.profile.kind !== 'runtime') fail(404, 'NOT_FOUND', 'Agent not found.');
      const { token, record } = newCredential({ account: login, scopes: input.scopes, ttlDays: input.ttlDays ?? DEFAULT_TTL_DAYS, label: input.label ?? '', now: now() });
      const saved = await store.issueCredential(login, agentId, record, now());
      if (!saved) fail(404, 'NOT_FOUND', 'Agent not found.');
      return { credential: publicCredential(saved, now()), token, notice: 'Copy this token now. It is shown once and stored only as a digest.' };
    },
    async credentials(login, agentId) { return (await store.credentials(login, agentId)).map(r => publicCredential(r, now())); },
    async revokeCredential(login, agentId, credentialId) {
      const r = await store.revokeCredential(login, agentId, credentialId, now());
      return r ? publicCredential(r, now()) : fail(404, 'NOT_FOUND', 'Credential not found.');
    },
    // Rotation: a new credential with the same scopes, then the old one revoked. No overlap.
    async rotateCredential(login, agentId, credentialId, input) {
      exact(input, [], ['ttlDays']);
      const old = (await store.credentials(login, agentId)).find(r => r.credentialId === credentialId);
      if (!old || credentialStatus(old, now()) !== 'active') fail(404, 'NOT_FOUND', 'Active credential not found.');
      const issued = await session.issueCredential(login, agentId, { scopes: old.scopes, ttlDays: input.ttlDays ?? DEFAULT_TTL_DAYS, label: old.label });
      await store.revokeCredential(login, agentId, credentialId, now(), r => ({ ...r, revokedAt: now(), rotatedTo: issued.credential.credentialId }));
      return issued;
    },
    async walletChallenge(login, agentId, input, origin, sessionDigest) {
      exact(input, ['wallet']);
      const found = await store.get(login, agentId);
      if (!found || found.profile.kind !== 'runtime') fail(404, 'NOT_FOUND', 'Agent not found.');
      if (found.profile.status === 'archived') fail(409, 'AGENT_ARCHIVED', 'This agent is archived.');
      const wallet = typeof input.wallet === 'string' && /^0x[0-9a-fA-F]{40}$/.test(input.wallet) ? input.wallet.toLowerCase() : fail(400, 'INVALID_INPUT', 'Enter the agent wallet address.');
      if (wallet === login.toLowerCase()) fail(400, 'INVALID_INPUT', 'Use a dedicated agent wallet, not your Mera account address.');
      if (reservedWallets.has(wallet)) fail(400, 'INVALID_INPUT', 'This address is reserved for Flurbo operations and cannot be an agent wallet.');
      if (links && await links.ownerOf(wallet, origin)) fail(400, 'INVALID_INPUT', 'This wallet is linked for manual MetaMask trading. Use a separate wallet for the agent.');
      const holder = await store.agentWallet(wallet);
      if (holder && holder.agentId !== agentId) fail(409, 'CONFLICT', 'This wallet is already the wallet of another agent.');
      const id = randomBytes(32).toString('base64url'), issued = now(), expires = issued + 300;
      const iso = s => new Date(s * 1000).toISOString();
      const message = `Flurbo agent wallet association\nOrigin: ${origin}\nMera account: ${login.toLowerCase()}\nAgent: ${agentId}\nAgent wallet: ${wallet}\nChain: Monad testnet (10143)\nNonce: ${id}\nIssued: ${iso(issued)}\nExpires: ${iso(expires)}\nThis proves control of this wallet so Flurbo can attribute its verified agent trades to this agent. It does not move funds, grant Flurbo any authority, or authorize a transaction.`;
      await store.putChallenge(id, { account: login.toLowerCase(), agentId, wallet, origin, session: sessionDigest, expires, message }, 300);
      return { id, message, expiresAt: expires, command: 'flurbo-agent sign-message --file <file containing this message>' };
    },
    async walletVerify(login, agentId, input, origin, sessionDigest) {
      exact(input, ['id', 'signature']);
      const owned = await store.get(login, agentId);
      if (!owned || owned.profile.kind !== 'runtime') fail(404, 'NOT_FOUND', 'Agent not found.');
      const proof = typeof input.id === 'string' ? await store.takeChallenge(input.id) : null; // single use, even when rejected
      if (!proof || proof.account !== login.toLowerCase() || proof.agentId !== agentId || proof.origin !== origin || proof.session !== sessionDigest || proof.expires <= now()
        || typeof input.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(input.signature)
        || !await verifyMessage({ address: proof.wallet, message: proof.message, signature: input.signature }).catch(() => false))
        fail(400, 'INVALID_INPUT', 'Wallet proof rejected. Request a new challenge and sign it with the agent wallet.');
      // Checked again at association: the wallet may have been linked for manual trading after the challenge.
      if (links && await links.ownerOf(proof.wallet, origin)) fail(400, 'INVALID_INPUT', 'This wallet is linked for manual MetaMask trading. Use a separate wallet for the agent.');
      const linkedKey = links?.ownerKey ? links.ownerKey(proof.wallet, origin) : null;
      const profile = await store.associateWallet(login, agentId, proof.wallet, now(), linkedKey).catch(e => (e.code === 'WALLET_LINKED'
        ? fail(400, 'INVALID_INPUT', e.message) : fail(409, e.code === 'WALLET_IN_USE' ? 'CONFLICT' : e.code ?? 'CONFLICT', e.message)));
      if (!profile) fail(404, 'NOT_FOUND', 'Agent not found.');
      return { wallet: profile.wallet, walletHistory: profile.walletHistory };
    },
    async setPolicy(login, agentId, input) {
      exact(input, [], ['paused', 'liveEnabled', 'maxTradeCostAtoms', 'windows', 'markets']);
      if ('paused' in input && typeof input.paused !== 'boolean') fail(400, 'INVALID_INPUT', 'paused must be true or false.');
      if ('liveEnabled' in input && typeof input.liveEnabled !== 'boolean') fail(400, 'INVALID_INPUT', 'liveEnabled must be true or false.');
      if ('maxTradeCostAtoms' in input && input.maxTradeCostAtoms !== null && !(typeof input.maxTradeCostAtoms === 'string' && /^[1-9][0-9]{0,8}$/.test(input.maxTradeCostAtoms) && BigInt(input.maxTradeCostAtoms) <= 100_000_000n))
        fail(400, 'INVALID_INPUT', 'The trade limit must be 1 to 100,000,000 atoms, or none.');
      if ('windows' in input && (!Array.isArray(input.windows) || input.windows.length > 3 || input.windows.some(w => !w || Object.keys(w).sort().join(',') !== 'atoms,seconds'
        || !Number.isInteger(w.seconds) || w.seconds < 60 || w.seconds > 30 * 86_400 || typeof w.atoms !== 'string' || !/^[1-9][0-9]{0,11}$/.test(w.atoms))))
        fail(400, 'INVALID_INPUT', 'Use up to three spending windows of 60 seconds to 30 days.');
      if ('markets' in input && (!Array.isArray(input.markets) || input.markets.length < 1 || input.markets.length > 20 || input.markets.some(m => !isNamespace(m) || !serviceFor(m))))
        fail(400, 'INVALID_INPUT', 'Choose available markets.');
      const updated = await store.update(login, agentId, async current => {
        if (current.kind !== 'runtime') fail(404, 'NOT_FOUND', 'Agent not found.');
        if (current.status === 'archived') fail(409, 'AGENT_ARCHIVED', 'This agent is archived.');
        const p = current.runtimePolicy;
        let limits = { maxTradeCostAtoms: 'maxTradeCostAtoms' in input ? input.maxTradeCostAtoms : p.limits.maxTradeCostAtoms, windows: input.windows ?? p.limits.windows };
        // Turning live trading on for an agent with no Flurbo limits (created before defaults existed) applies the
        // defaults, unless this same request sets its own limits.
        if (input.liveEnabled === true && !p.liveEnabled && !('maxTradeCostAtoms' in input) && !('windows' in input) && limits.maxTradeCostAtoms === null && !limits.windows.length) limits = defaultLimits();
        return { ...current, markets: input.markets ?? current.markets, updatedAt: now(), runtimePolicy: { version: p.version + 1, paused: input.paused ?? p.paused, liveEnabled: input.liveEnabled ?? p.liveEnabled, limits } };
      });
      return updated ? policyView(updated, now()) : fail(404, 'NOT_FOUND', 'Agent not found.');
    },
    checkExecution,
  };

  // Runtime side (bearer credential).
  const SCOPE_OF = { session: null, deployments: 'markets:read', market: 'markets:read', semantics: 'markets:read', quote: 'markets:read', claimAnalytics: 'markets:read', pairAnalytics: 'markets:read',
    wallet: 'wallet:read', policy: 'runtime:report', heartbeat: 'runtime:report', decisions: 'runtime:report', reportExecution: 'executions:report', execution: 'executions:report' };
  const ARCHIVED_ALLOWED = ['session', 'reportExecution', 'execution'];
  function route(method, parts) {
    const [a, b, c] = parts;
    if (method === 'GET' && parts.length === 1 && a === 'session') return ['session'];
    if (method === 'GET' && parts.length === 1 && a === 'deployments') return ['deployments'];
    if (method === 'GET' && parts.length === 1 && a === 'policy') return ['policy'];
    if (method === 'POST' && parts.length === 1 && a === 'heartbeat') return ['heartbeat'];
    if (method === 'POST' && parts.length === 1 && a === 'decisions') return ['decisions'];
    if (method === 'POST' && parts.length === 1 && a === 'executions') return ['reportExecution'];
    if (method === 'GET' && parts.length === 2 && a === 'executions') return ['execution', b];
    if (a === 'markets' && parts.length === 2 && method === 'GET') return ['market', b];
    if (a === 'markets' && parts.length === 3 && method === 'POST' && c === 'validate-trade') return ['semantics', b];
    if (a === 'markets' && parts.length === 3 && method === 'POST' && ['quote', 'claim-analytics', 'pair-analytics', 'wallet'].includes(c))
      return [{ quote: 'quote', 'claim-analytics': 'claimAnalytics', 'pair-analytics': 'pairAnalytics', wallet: 'wallet' }[c], b];
    return null;
  }

  async function handle({ method, path, headers, body, hosted = false }) {
    try {
      // Browsers always send Sec-Fetch-Site and Sec-Fetch-Dest; server runtimes (including Node's fetch, which sends only
      // Sec-Fetch-Mode) do not.
      if (headers['sec-fetch-site'] || headers['sec-fetch-dest']) fail(403, 'BROWSER_NOT_SUPPORTED', 'The agent runtime API is for runtimes outside the browser. Use the agent page in the browser.');
      if (headers['flurbo-agent-protocol'] !== PROTOCOL_VERSION) fail(400, 'UNSUPPORTED_PROTOCOL', `Send Flurbo-Agent-Protocol: ${PROTOCOL_VERSION}.`);
      const minute = Math.floor(now() / 60);
      let record;
      try { record = await authenticate(store, headers.authorization, now()); }
      catch(e) {
        if(hosted && await bump(`unauthenticated:${minute}`,120)>300)throw new RuntimeError(429,'RATE_LIMITED','Retry after the cooldown.',60-now()%60);
        throw e;
      }
      if (await bump(`credential:${record.credentialId}:${minute}`, 120) > RATE_PER_MINUTE) throw new RuntimeError(429, 'RATE_LIMITED', 'Rate limit reached for this credential.', 60 - (now() % 60));
      if (await bump(`account:${record.account.toLowerCase()}:${minute}`,120)>240)throw new RuntimeError(429,'RATE_LIMITED','Rate limit reached for this account.',60-now()%60);
      if (hosted && await bump(`service:${minute}`,120)>SERVICE_PER_MINUTE)throw new RuntimeError(429,'RATE_LIMITED','The agent API is busy. Retry shortly.',60-now()%60);
      if (previewAllows && !await previewAllows(record.account)) fail(403, 'INVITE_REQUIRED', 'Testnet access is not approved for the account that owns this agent.');
      const found = await store.get(record.account, record.agentId);
      if (!found || found.profile.kind !== 'runtime') fail(404, 'NOT_FOUND', 'Agent not found.');
      const parts = path.replace(/^\/api\/agent-runtime\/v1\/?/, '').split('/').filter(Boolean), matched = route(method, parts);
      if (!matched) fail(404, 'NOT_FOUND', 'Unknown agent runtime endpoint.');
      const [name, param] = matched, scope = SCOPE_OF[name];
      if (scope && !record.scopes.includes(scope)) fail(403, 'SCOPE_REQUIRED', `This credential lacks the ${scope} scope.`);
      if (found.profile.status === 'archived' && !ARCHIVED_ALLOWED.includes(name)) fail(403, 'AGENT_ARCHIVED', 'This agent is archived. Stop starting new actions; submitted transactions can still be reported.');
      if (!record.lastUsedAt || now() - record.lastUsedAt >= 60) await store.touchCredential(record.credentialId, now()).catch(() => {});
      const input = method === 'POST' ? parseBody(body) : undefined;
      return { status: 200, body: await routes[name]({ record, profile: found.profile, state: found.state, param, input }) };
    } catch (e) {
      if(e instanceof CapacityError)return {status:429,body:{code:e.code,error:e.message,retryable:true},retryAfter:e.retryAfter};
      if (e instanceof RuntimeError) return { status: e.status, body: { code: e.code, error: e.message, retryable: [429, 503].includes(e.status) }, retryAfter: e.retryAfter };
      if (e?.status === 409) return { status: 409, body: { code: e.code === 'HASH_CONFLICT' ? 'HASH_CONFLICT' : 'CONFLICT', error: e.message, retryable: e.code === 'BUSY' } };
      return { status: 503, body: { code: 'UNAVAILABLE', error: 'The agent service is temporarily unavailable.', retryable: true } };
    }
  }
  const parseBody = body => { try { const v = JSON.parse(body); return v; } catch { return fail(400, 'INVALID_INPUT', 'Send a JSON body.'); } };
  const allowedMarket = (profile, namespace) => { if (!profile.markets.includes(namespace)) fail(404, 'NOT_FOUND', 'That market is not enabled for this agent.'); return service(namespace); };

  const routes = {
    semantics: ({ profile, param, input }) => {
      const svc = allowedMarket(profile, param);
      try { return assessSemantics(svc.manifest, input); }
      catch (e) { if (e.status === 400) fail(400, 'INVALID_INPUT', e.message); throw e; }
    },
    session: ({ record, profile }) => ({ schema: 'flurbo.agent-runtime-session.v1', protocol: PROTOCOL_VERSION, agentId: profile.id, agentName: profile.name, status: profile.status,
      credential: { credentialId: record.credentialId, scopes: record.scopes, expiresAt: record.expiresAt }, wallet: profile.wallet, markets: profile.markets, serverTime: now() }),
    deployments: ({ profile }) => ({ schema: 'flurbo.agent-deployments.v1', deployments: profile.markets.map(ns => serviceFor(ns) && deploymentOf(ns, serviceFor(ns))).filter(Boolean) }),
    async market({ profile, param }) {
      const svc = allowedMarket(profile, param), m = svc.manifest, draft = m.publication.draft, view = await svc.markets();
      const settlement = settlementSources(m);
      let resolution = null;
      if (view.resolved) { try { resolution = await readResolution({ rpc, pool: m.pool }); } catch { resolution = null; } }
      return { schema: 'flurbo.agent-market.v1', namespace: param, deployment: deploymentOf(param, svc), title: String(draft.title ?? ''), closesAt: draft.closesAt,
        open: view.open, resolved: view.resolved, resolution, snapshot: view.snapshot,
        events: draft.events.map((e, index) => ({ index, id: e.id, question: e.question, yesRule: e.yesRule, noRule: e.noRule, observationStartsAt: e.observationStartsAt ?? null,
          observationEndsAt: e.observationEndsAt, source: e.source ? { publisher: e.source.publisher ?? null, referenceUrl: e.source.referenceUrl ?? null } : null,
          settlement: settlement[index] ?? null })),
        oneShareBuyAtoms: view.prices.map(p => ({ event: p.event, yes: p.yes, no: p.no })) };
    },
    async quote({ profile, param, input }) {
      exact(input, ['side', 'scope', 'mask', 'quantityAtoms']);
      const svc = allowedMarket(profile, param), events = svc.manifest.publication.draft.events.length;
      if (!['buy', 'sell'].includes(input.side) || typeof input.mask !== 'string' || !/^[1-9][0-9]{0,2}$/.test(input.mask) || !validClaim(input.scope, BigInt(input.mask), events)
        || typeof input.quantityAtoms !== 'string' || !/^[1-9][0-9]{0,8}$/.test(input.quantityAtoms) || BigInt(input.quantityAtoms) > 100_000_000n) fail(400, 'INVALID_INPUT', 'Choose a supported claim, side and quantity.');
      return (await quoteClaims({ service: svc, rpc, claims: [{ scope: input.scope, mask: BigInt(input.mask) }], quantityAtoms: BigInt(input.quantityAtoms), side: input.side }))[0];
    },
    async claimAnalytics({ profile, param, input }) {
      exact(input, ['scope', 'mask']);
      const svc = allowedMarket(profile, param);
      if (!svc.claimAnalytics) fail(503, 'UNAVAILABLE', 'Claim analytics are unavailable for this market.');
      try { return await svc.claimAnalytics(input); } catch { return fail(503, 'UNAVAILABLE', 'Claim analytics are temporarily unavailable.'); }
    },
    async pairAnalytics({ profile, param, input }) {
      exact(input, ['a', 'b']);
      const svc = allowedMarket(profile, param);
      if (!svc.analytics) fail(503, 'UNAVAILABLE', 'Pair analytics are unavailable for this market.');
      try { return await svc.analytics(input); } catch { return fail(503, 'UNAVAILABLE', 'Pair analytics are temporarily unavailable.'); }
    },
    async wallet({ profile, param, input }) {
      exact(input, ['claims']);
      const svc = allowedMarket(profile, param);
      if (!profile.wallet) fail(409, 'WALLET_REQUIRED', 'Associate the agent wallet on the agent page first.');
      const owner = profile.wallet, positions = await svc.positions(owner, input.claims), tag = '0x' + BigInt(positions.snapshot.blockNumber).toString(16);
      const read = async (fn, args) => decodeFunctionResult({ abi: pilotCashAbi, functionName: fn, data: await rpc('eth_call', [{ to: pilotCash, data: encodeFunctionData({ abi: pilotCashAbi, functionName: fn, args }) }, tag]) });
      const [collateral, allowance, native] = await Promise.all([read('balanceOf', [owner]), read('allowance', [owner, svc.manifest.pool]), rpc('eth_getBalance', [owner, tag])]);
      return { schema: 'flurbo.agent-wallet-state.v1', wallet: owner, namespace: param, snapshot: positions.snapshot, collateralAtoms: collateral.toString(), allowanceAtoms: allowance.toString(),
        nativeBalanceWei: BigInt(native).toString(), holdings: positions.rows.map(r => ({ scope: r.scope, mask: String(r.mask), quantityAtoms: String(r.quantity), payoutAtoms: r.payoutAtoms === null ? null : String(r.payoutAtoms) })) };
    },
    policy: ({ profile }) => policyView(profile, now()),
    async heartbeat({ record, profile, input }) {
      exact(input, ['runtimeId', 'sdk', 'mode', 'state', 'policy', 'pending', 'startedAt'], ['lastCycleAt', 'lastErrorCode']);
      const text = (v, max) => typeof v === 'string' && v.length >= 1 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
      if (!text(input.runtimeId, 64) || !input.sdk || !['typescript', 'python', 'rust', 'cpp'].includes(input.sdk.language) || !text(input.sdk.version, 32)
        || !['paper', 'live'].includes(input.mode) || !['running', 'paused', 'blocked', 'stopping', 'stopped'].includes(input.state) || !Number.isInteger(input.pending) || input.pending < 0 || input.pending > 1000
        || !Number.isSafeInteger(input.startedAt) || !input.policy || typeof input.policy !== 'object' || !/^[0-9a-f]{64}$/.test(input.policy.hash ?? '')
        || !(input.policy.flurboVersion === null || Number.isInteger(input.policy.flurboVersion)) || JSON.stringify(input.policy.summary ?? {}).length > 4000
        || ('lastErrorCode' in input && input.lastErrorCode !== null && !/^[A-Za-z_]{1,48}$/.test(input.lastErrorCode))) fail(400, 'INVALID_INPUT', 'Malformed heartbeat.');
      const beat = { runtimeId: input.runtimeId, sdk: { language: input.sdk.language, version: input.sdk.version }, mode: input.mode, state: input.state, pending: input.pending,
        startedAt: input.startedAt, lastCycleAt: input.lastCycleAt ?? null, lastErrorCode: input.lastErrorCode ?? null,
        policy: { hash: input.policy.hash, flurboVersion: input.policy.flurboVersion, summary: input.policy.summary ?? {} }, credentialId: record.credentialId, receivedAt: now() };
      remember(record.account, profile.id, beat);
      const k = agentKey(record.account, profile.id) + ':' + beat.runtimeId, previous = written.get(k);
      if (!previous || material(previous) !== material(beat) || beat.receivedAt - previous.receivedAt >= HEARTBEAT_PERSIST_SECONDS) {
        await store.mutate(record.account, profile.id, state => {
          state.runtime.heartbeats = [beat, ...state.runtime.heartbeats.filter(h => h.runtimeId !== beat.runtimeId)].slice(0, AGENT_LIMITS.heartbeats);
          return true;
        });
        written.set(k, beat);
      }
      return { ...policyView(profile, now()), acknowledged: input.policy.flurboVersion === profile.runtimePolicy.version };
    },
    async decisions({ record, profile, input }) {
      const decision = parseDecision(input, profile, serviceFor, now());
      return store.mutate(record.account, profile.id, state => {
        const existing = state.runtime.decisions.find(d => d.decisionId === decision.decisionId);
        if (existing) return existing;
        state.runtime.decisions.unshift(decision);
        return decision;
      });
    },
    async reportExecution({ record, profile, input }) {
      exact(input, ['namespace', 'hash', 'intent'], ['decisionId', 'nonce', 'sdk']);
      const svc = allowedMarket(profile, input.namespace), hash = typeof input.hash === 'string' ? input.hash.toLowerCase() : '';
      if (!HASH.test(hash)) fail(400, 'INVALID_INPUT', 'Invalid transaction hash.');
      const intent = parseIntent(input.intent, svc.manifest.publication.draft.events.length);
      if (!intent) fail(400, 'INVALID_INPUT', 'Invalid execution intent.');
      if (!profile.wallet && !(profile.walletHistory ?? []).length) fail(409, 'WALLET_REQUIRED', 'Associate the agent wallet on the agent page first.');
      const decisionId = input.decisionId ?? null;
      if (decisionId !== null && (typeof decisionId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(decisionId))) fail(400, 'INVALID_INPUT', 'Invalid decision id.');
      await store.mutate(record.account, profile.id, async (state, _p, own) => {
        const existing = state.runtime.executions.find(e => e.hash === hash);
        if (existing) {
          if (JSON.stringify(existing.intent) !== JSON.stringify(intent) || existing.namespace !== input.namespace) throw Object.assign(new Error('This hash was reported with a different intent.'), { status: 409, code: 'HASH_CONFLICT' });
          return existing;
        }
        const owner = await own.read(hash);
        if (owner && !own.owns(owner, `execution:${hash}`, owner.transaction)) throw Object.assign(new Error('This transaction is already attributed elsewhere.'), { status: 409, code: 'HASH_CONFLICT' });
        if (state.runtime.executions.filter(e => !FINAL_EXECUTION.includes(e.status)).length >= AGENT_LIMITS.pendingExecutions) fail(409, 'TOO_MANY_PENDING', 'Too many executions are still being verified.');
        const entry = { hash, namespace: input.namespace, intent, decisionId, provenance: 'sdk-runtime', reportedAt: now(), credentialId: record.credentialId,
          sdk: input.sdk && typeof input.sdk === 'object' ? { language: String(input.sdk.language ?? '').slice(0, 16), version: String(input.sdk.version ?? '').slice(0, 32) } : null,
          status: 'recorded', verification: null, checkedAt: null };
        state.runtime.executions.unshift(entry);
        return entry;
      });
      return checkExecution(record.account, profile.id, hash);
    },
    async execution({ record, profile, param }) {
      const hash = typeof param === 'string' ? param.toLowerCase() : '';
      if (!HASH.test(hash)) fail(400, 'INVALID_INPUT', 'Invalid transaction hash.');
      return checkExecution(record.account, profile.id, hash);
    },
  };
  return { handle, session, heartbeatsFor };
}

// A self-reported decision from the runtime. Stored for the owner and labelled as reported; never used to
// move funds or change policy.
export function parseDecision(v, profile, serviceFor, now) {
  exact(v, ['schema', 'decisionId', 'namespace', 'createdAt', 'outcome', 'reasons', 'provenance'], ['forecast', 'candidate', 'violations', 'execution', 'summary']);
  if (v.schema !== 'flurbo.agent-runtime-decision.v1' || typeof v.decisionId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v.decisionId)) fail(400, 'INVALID_INPUT', 'Malformed decision.');
  if (!profile.markets.includes(v.namespace) || !serviceFor(v.namespace)) fail(400, 'INVALID_INPUT', 'Unknown market for this agent.');
  if (!Number.isSafeInteger(v.createdAt) || v.createdAt > now + 300) fail(400, 'INVALID_INPUT', 'Invalid decision time.');
  if (!['trade', 'paper', 'abstain', 'rejected_by_policy'].includes(v.outcome)) fail(400, 'INVALID_INPUT', 'Unknown decision outcome.');
  if (!Array.isArray(v.reasons) || v.reasons.length > 16 || v.reasons.some(r => typeof r !== 'string' || !/^[a-z_A-Z]{1,48}$/.test(r))) fail(400, 'INVALID_INPUT', 'Invalid reasons.');
  if (!v.provenance || !['model', 'fixture', 'custom'].includes(v.provenance.kind) || typeof v.provenance.name !== 'string' || v.provenance.name.length > 64) fail(400, 'INVALID_INPUT', 'Invalid provenance.');
  const svc = serviceFor(v.namespace), m = svc.manifest;
  let forecast = null;
  if (v.forecast !== undefined && v.forecast !== null) {
    try { forecast = parseForecast(v.forecast, { eventCount: m.publication.draft.events.length, pool: m.pool, now: new Date(now * 1000) }); }
    catch (e) { fail(400, 'INVALID_INPUT', e instanceof FlurboError ? `Forecast: ${e.message}` : 'Invalid forecast.'); }
  }
  const small = (x, max) => (x === undefined || x === null ? null : JSON.stringify(x).length <= max ? x : fail(400, 'INVALID_INPUT', 'Decision detail too large.'));
  return { schema: v.schema, decisionId: v.decisionId, namespace: v.namespace, createdAt: v.createdAt, receivedAt: now, outcome: v.outcome, reasons: v.reasons,
    provenance: { kind: v.provenance.kind, name: v.provenance.name }, forecast: forecast && { ...forecast, joint: { events: forecast.joint.events, statesPpm: forecast.joint.states.map(String) } },
    candidate: small(v.candidate, 2000), violations: small(v.violations, 1000), execution: small(v.execution, 300), summary: typeof v.summary === 'string' ? v.summary.slice(0, 600) : null, selfReported: true };
}
