import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useRoute } from 'wouter';
import { useAuth } from '../auth/context';
import { discoverWallets, type BrowserWallet } from '../auth/wallet-choice';
import { watchTradingWallet, type TradingConnection } from '../auth/trading-session';
import { linkedWallets } from '../wallet-links';
import { submitPilot, readPilotPending, pendingKeyFor, validatePilotReview, PurchaseSemanticCollision, type PilotPending, type PilotNamespace, type PilotReview } from '../pilot';
import { SemanticReview } from '../components/SemanticReview';
import { rememberConfirmedClaim } from '../pilot-claims';
import { describeClaim, amount } from '../portfolio';
import { agentClient, runtimeAdmin, buildForecast, frechetBounds, percentToPpm, message, type ProfileJSON, type RecordJSON, type ReviewJSON, type EvidenceInput } from '../agents-client';
import { RuntimeCreateForm, RuntimeAgentDetail } from './AgentRuntime';
import { ArrowLeft, Bot } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import StatusBadge from '../components/ui/StatusBadge';
import { useLoadGate } from '../loading/gates';
import './agents.css';

type Market = Awaited<ReturnType<typeof agentClient.market>>;
const pct = (ppm: string | bigint | null | undefined) => (ppm === null || ppm === undefined ? 'Unavailable' : `${(Number(BigInt(ppm)) / 10_000).toFixed(1)}%`);
const tenths = (v: number | null | undefined) => (v === null || v === undefined ? 'Not certified' : `${(v / 10).toFixed(1)}%`);
const when = (seconds: number) => new Date(seconds * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const REASONS: Record<string, string> = {
  market_closed: 'Trading is closed for this pool.', insufficient_evidence: 'The forecast does not have enough recent evidence.',
  no_supported_claim: 'No supported claim is covered by this forecast.', quote_unavailable: 'The pool did not quote one or more claims.',
  quote_expired: 'The quote expired before the decision.', budget_exceeded: 'The cost would exceed the agent budget.',
  edge_below_threshold: 'No claim clears the minimum edge after cost and slippage.', cross_pool: 'The forecast belongs to a different pool.',
};
const STATUS: Record<string, string> = {
  preparing: 'Preparing the transaction review', 'awaiting-approval': 'Awaiting your approval in MetaMask', submitted: 'Submitted, waiting for confirmation',
  'approval-confirmed': 'Token approval confirmed. Purchase not sent yet.', confirmed: 'Purchase confirmed on-chain', failed: 'Failed',
  rejected: 'Rejected in MetaMask or dismissed', expired: 'Review expired before a transaction was recorded', 'preparation-failed': 'Could not be prepared',
  'preparation-expired': 'Preparation timed out', 'attributed-elsewhere': 'Its transaction was verified for another proposal and is not counted here',
};
// Statuses that keep a decision from getting another proposal (the server enforces the same rule).
const BLOCKING = ['preparing', 'awaiting-approval', 'expired', 'submitted', 'approval-confirmed', 'confirmed'];
const OPEN = ['preparing', 'awaiting-approval', 'expired', 'submitted', 'approval-confirmed'];
const short = (hash: string) => `${hash.slice(0, 10)}...${hash.slice(-6)}`;
const TX_FIELDS = ['from', 'to', 'data', 'chainId', 'value'] as const;
const sameTransaction = (a: any, b: any) => !!a && !!b && TX_FIELDS.every(f => typeof a[f] === 'string' && typeof b[f] === 'string' && a[f].toLowerCase() === b[f].toLowerCase());
// A locally saved MetaMask transaction belongs to a proposal only for the same Flurbo account, wallet,
// chain and pool, and one of the exact transactions the proposal's reviews carried.
function belongsTo(r: RecordJSON, saved: PilotPending, login: string, pool: string) {
  const tx = saved.review.transaction;
  return r.kind === 'proposal' && !!login && saved.login.toLowerCase() === login.toLowerCase() && r.account === login.toLowerCase()
    && r.owner === tx.from.toLowerCase() && tx.chainId === '0x279f' && saved.review.manifest.pool.toLowerCase() === pool.toLowerCase()
    && [r.review?.transaction, ...(r.reviewedTransactions ?? []), ...(r.transactions ?? []).map((t: any) => t.review?.transaction)].some(x => sameTransaction(x, tx));
}

export default function Agents() {
  const [match, params] = useRoute('/agents/:id');
  return <main id="main" tabIndex={-1} className="page markets-page agents-page">
    {match && params?.id ? <AgentPage id={params.id}/> : <AgentList/>}
  </main>;
}

// Runtime agents and assisted agents share the URL space; the profile says which page to show.
function AgentPage({ id }: { id: string }) {
  const [kind, setKind] = useState<'runtime' | 'assisted' | null>(null), [error, setError] = useState('');
  useEffect(() => { let live = true; runtimeAdmin.get(id).then(d => { if (live) setKind(d.profile.kind === 'runtime' ? 'runtime' : 'assisted'); }).catch(e => { if (live) setError(message(e)); }); return () => { live = false; }; }, [id]);
  useLoadGate('agent', { pending: kind === null && !error, error: kind === null ? error : null, label: 'Loading your agent' });
  if (error) return <><p className="state-inline error" role="alert">{error}</p><Link href="/agents" className="link-back"><ArrowLeft aria-hidden="true" strokeWidth={1.75}/>Back to agents</Link></>;
  return kind === null ? <p role="status" className="sr-only">Loading agent...</p> : kind === 'runtime' ? <RuntimeAgentDetail id={id}/> : <AgentDetail id={id}/>;
}

function AgentList() {
  const [agents, setAgents] = useState<ProfileJSON[] | null>(null), [directory, setDirectory] = useState<{ namespace: string; label: string; open?:boolean }[]>([]);
  const [name, setName] = useState(''), [namespace, setNamespace] = useState(''), [mode, setMode] = useState<'paper' | 'approval'>('paper');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [durable, setDurable] = useState(true), [archived, setArchived] = useState<ProfileJSON[]>([]);
  const [, navigate] = useLocation();
  useEffect(() => {
    const c = new AbortController();
    void agentClient.agents.list(c.signal).then((r: any) => { setAgents(r.agents); setArchived(r.archived ?? []); setDurable(r.durable); }).catch(e => { if (!c.signal.aborted) setError(message(e)); });
    void agentClient.directory(c.signal).then(async d => { const choices=await Promise.all(d.map(async entry=>{try{const market=await agentClient.market(entry.namespace as PilotNamespace,c.signal);return {...entry,open:market.open&&market.closesAt>Date.now()/1000};}catch{return {...entry,open:false};}}));if(!c.signal.aborted){setDirectory(choices);setNamespace(v=>v||choices.find(x=>x.open)?.namespace||'');} }).catch(() => {});
    return () => c.abort();
  }, []);
  async function create(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { const created = await agentClient.agents.create({ name, namespace, mode }) as ProfileJSON; navigate(`/agents/${created.id}`); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  // The list has its own skeleton, so the page and its register form are usable at once instead of waiting
  // behind the loader for the agent list; only a failure to load the list reaches the page-level loader.
  useLoadGate('agents', { pending: false, error: agents === null ? error : null, label: 'Loading your agents' });
  return <>
    <PageHeader className="agents-heading" title="Build agents that trade relationships."
      lead="Write an agent with the Flurbo SDK and run it on your own computer or server. Flurbo does not host a model for you; it shows your agent's status, decisions and verified trades here."
      actions={<a href="#register-agent" className="btn btn-primary">Register an agent</a>}/>
    <p className="agents-explainer">Paper mode records what your agent would have traded without sending anything on-chain. Live testnet trades need your explicit permission, a dedicated agent wallet and limits you set.</p>
    {!durable && <p className="agents-note" role="status">Development storage: agents on this server are not durable.</p>}
    {error && <p className="state-inline error" role="alert">{error}</p>}
    <section className="agents-grid">
      <div className="agents-list" aria-label="Your agents">
        <h2>Your agents</h2>
        {agents === null ? <><p role="status" className="sr-only">Loading agents...</p><div className="agents-rows-skeleton" aria-hidden="true"><span className="skeleton" style={{ height: 64 }}/><span className="skeleton" style={{ height: 64 }}/></div></> : agents.length === 0 ? <div className="state-block"><Bot aria-hidden="true" strokeWidth={1.75}/><p>No agents yet. Register one to start in paper mode.</p></div> :
          <ul>{agents.map(a => <li key={a.id}><Link href={`/agents/${a.id}`}><strong>{a.name}</strong><span>{a.kind === 'runtime' ? (a.markets ?? []).map(ns=>directory.find(d=>d.namespace===ns)?.label||'Related markets').join(', ') : a.market.title || a.market.namespace}</span>
            <span className="agents-tags">{a.kind === 'runtime' ? <><span className="agents-kind">Runs on your infrastructure</span><StatusBadge kind={a.runtimePolicy?.paused ? 'waiting' : a.runtimePolicy?.liveEnabled ? 'open' : 'settled'}>{a.runtimePolicy?.paused ? 'Paused' : a.runtimePolicy?.liveEnabled ? 'Live trades allowed' : 'Paper until allowed'}</StatusBadge></>
              : <><span className="agents-kind">Assisted, {a.mode === 'paper' ? 'Paper only' : 'Proposes for approval'}</span><StatusBadge kind={a.status === 'active' ? 'open' : 'waiting'}>{a.status === 'active' ? 'Active' : 'Paused'}</StatusBadge></>}</span></Link></li>)}</ul>}
        {archived.length > 0 && <details className="agents-archived"><summary>Archived agents ({archived.length})</summary>
          <p className="agents-fine">Kept so a transaction already sent from one of their proposals can still be recorded and verified.</p>
          <ul>{archived.map(a => <li key={a.id}><Link href={`/agents/${a.id}`}><strong>{a.name}</strong><span>{a.kind === 'runtime' ? (a.markets ?? []).map(ns=>directory.find(d=>d.namespace===ns)?.label||'Related markets').join(', ') : a.market.title || a.market.namespace}</span></Link></li>)}</ul></details>}
      </div>
      <div>
      <RuntimeCreateForm directory={directory}/><p className="agents-fine">SDKs for TypeScript, Python, Rust and C++. <Link href="/docs#agents">Read the setup guide</Link></p>
      <details className="agents-card agents-settings disclosure"><summary>Assisted agent: manual forecasts, paper trades and MetaMask approval</summary>
      <form onSubmit={create}>
        <h2>Create an assisted agent</h2>
        <label>Name<input value={name} onChange={e => setName(e.target.value)} maxLength={48} required placeholder="Assisted release agent"/></label>
        <label>Market<select value={namespace} onChange={e => setNamespace(e.target.value)} required>{directory.map(d => <option key={d.namespace} value={d.namespace} disabled={!d.open}>{d.label}{!d.open?' · Unavailable for new trades':''}</option>)}</select></label>
        <fieldset className="agents-choice"><legend>Mode</legend>
          <label><input type="radio" checked={mode === 'paper'} onChange={() => setMode('paper')}/>Paper only<small>Simulated trades. Nothing is sent on-chain.</small></label>
          <label><input type="radio" checked={mode === 'approval'} onChange={() => setMode('approval')}/>Propose for approval<small>Prepares real trades that you confirm in MetaMask.</small></label>
        </fieldset>
        <p className="agents-fine">Strategy: joint edge v1. It never signs, never moves funds and never trades automatically.</p>
        <button className="button button-dark" disabled={busy || !namespace}>{busy ? 'Creating...' : 'Create assisted agent'}</button>
      </form>
      </details>
      </div>
    </section>
  </>;
}

function AgentDetail({ id }: { id: string }) {
  const { state: auth } = useAuth();
  const [profile, setProfile] = useState<ProfileJSON | null>(null), [records, setRecords] = useState<RecordJSON[]>([]), [market, setMarket] = useState<Market | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [performance, setPerformance] = useState<any>(null), [deleting, setDeleting] = useState(false);
  const [, navigate] = useLocation();
  const load = useCallback(async (signal?: AbortSignal) => {
    const found = await agentClient.agents.get(id, signal) as { profile: ProfileJSON; records: RecordJSON[] };
    setProfile(found.profile); setRecords(found.records);
    setMarket(await agentClient.market(found.profile.market.namespace as PilotNamespace, signal));
  }, [id]);
  useEffect(() => { const c = new AbortController(); void load(c.signal).catch(e => { if (!c.signal.aborted) setError(message(e)); }); return () => c.abort(); }, [load]);
  async function act(fn: () => Promise<void>) { setBusy(true); setError(''); try { await fn(); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  useLoadGate('agent-assisted', { pending: (!profile || !market) && !error, error: !profile ? error : null, label: 'Loading your agent' });
  if (error && !profile) return <><p className="state-inline error" role="alert">{error}</p><Link href="/agents" className="link-back"><ArrowLeft aria-hidden="true" strokeWidth={1.75}/>Back to agents</Link></>;
  if (!profile || !market) return <p role="status" className="sr-only">Loading agent...</p>;
  const questions = market.events.map(e => e.question);
  const latest = records.find(r => r.kind === 'decision'), isArchived = profile.status === 'archived';
  return <>
    <nav className="agents-back"><Link href="/agents" className="link-back"><ArrowLeft aria-hidden="true" strokeWidth={1.75}/>All agents</Link></nav>
    <header className="agents-profile">
      <div className="agents-profile-title"><span className="chip">{profile.mode === 'paper' ? 'Paper only' : 'Proposes for your approval'} · {isArchived ? 'Archived' : profile.status === 'active' ? 'Active' : 'Paused'}</span>
        <h1>{profile.name}</h1><p>{market.title}. Trading {market.open ? `closes ${when(market.closesAt)}` : 'is closed'}.</p></div>
      {!isArchived && <div className="agents-actions">
        <button className="button button-outline" disabled={busy} onClick={() => act(async () => { setProfile(await agentClient.agents.update(id, { status: profile.status === 'active' ? 'paused' : 'active' }) as ProfileJSON); })}>{profile.status === 'active' ? 'Pause' : 'Resume'}</button>
        <button className="button button-outline" disabled={busy} onClick={() => act(async () => { setProfile(await agentClient.agents.update(id, { mode: profile.mode === 'paper' ? 'approval' : 'paper' }) as ProfileJSON); })}>{profile.mode === 'paper' ? 'Allow proposals' : 'Paper only'}</button>
        {deleting ? <><span className="agents-fine">Delete this agent? It stops evaluating and proposing, and its activity is cleared. Its proposals and transaction records are kept, so a transaction already sent can still be recorded and verified. On-chain trades are unaffected.</span>
          <button className="button button-dark" disabled={busy} onClick={() => act(async () => { await agentClient.agents.remove(id); navigate('/agents'); })}>Confirm delete</button>
          <button className="button button-outline" disabled={busy} onClick={() => setDeleting(false)}>Keep</button></>
          : <button className="button button-outline" disabled={busy} onClick={() => setDeleting(true)}>Delete</button>}
      </div>}
    </header>
    {isArchived && <p className="agents-note" role="status">This agent is archived. It no longer evaluates or proposes. Transactions sent from its proposals can still be recorded and checked below.</p>}
    {!isArchived && <Settings profile={profile}/>}
    {error && <p className="state-inline error" role="alert">{error}</p>}
    {notice && <p className="agents-note" role="status">{notice}</p>}
    {!isArchived && <ForecastForm market={market} disabled={busy || profile.status !== 'active'} onSubmit={forecast => act(async () => {
      setNotice('Evaluating with current pool quotes...');
      const record = await agentClient.agents.evaluate(id, { forecast }) as RecordJSON;
      setRecords(r => [record, ...r]); setNotice('');
    })}/>}
    {latest && !isArchived && <DecisionCard record={latest} questions={questions} market={market} profile={profile} busy={busy}
      hasLiveProposal={records.some(r => r.kind === 'proposal' && r.decisionId === latest.id && BLOCKING.includes(r.status))}
      paper={() => act(async () => { const r = await agentClient.agents.paper(id, latest.id) as RecordJSON; setRecords(x => [r, ...x]); setNotice('Paper trade recorded. Nothing was sent on-chain.'); })}
      proposalAdded={r => setRecords(x => [r, ...x])}/>}
    <Approvals id={id} profile={profile} records={records} setRecords={setRecords} questions={questions} login={auth.address ?? ''} reload={() => load()}/>
    <section className="agents-card">
      <div className="agents-row"><h2>Results</h2><button className="button button-outline" disabled={busy} onClick={() => act(async () => { setPerformance(await agentClient.agents.performance(id)); })}>Refresh results</button></div>
      {performance ? <Performance data={performance}/> : <p className="agents-fine">Load results to see paper outcomes and confirmed agent purchases.</p>}
    </section>
    <Activity records={records} questions={questions}/>
  </>;
}

function Settings({ profile }: { profile: ProfileJSON }) {
  const c = profile.config;
  return <details className="agents-card agents-settings"><summary>Strategy settings</summary>
    <dl>
      <dt>Quantity per proposal</dt><dd>{amount(String(c.quantityAtoms))} share(s)</dd>
      <dt>Minimum edge</dt><dd>{Number(c.minEdgeBps) / 100}% of worst-case cost, and at least {amount(String(c.minEdgeAtoms))} test AUSD</dd>
      <dt>Budget per proposal</dt><dd>{amount(String(c.maxCostAtoms))} test AUSD worst case</dd>
      <dt>Slippage allowance</dt><dd>{Number(c.slippageBps) / 100}%</dd>
      <dt>Evidence</dt><dd>At least {String(c.minEvidence)} item(s) observed within {String(c.maxEvidenceAgeDays)} days</dd>
      <dt>Paper budget</dt><dd>{amount(String(c.paperBudgetAtoms))} test AUSD</dd>
    </dl>
    <p className="agents-fine">Edge assumes no VOID outcome and excludes gas. It is a model estimate, not a promised profit.</p>
  </details>;
}

function ForecastForm({ market, disabled, onSubmit }: { market: Market; disabled: boolean; onSubmit: (forecast: unknown) => void }) {
  const [a, setA] = useState(0), [b, setB] = useState(1), [pA, setPA] = useState(''), [pB, setPB] = useState(''), [pBoth, setPBoth] = useState('');
  const [evidence, setEvidence] = useState<EvidenceInput>({ title: '', source: '', url: '', observedAt: '', note: '' });
  const [explanation, setExplanation] = useState(''), [uncertainty, setUncertainty] = useState(''), [assumptions, setAssumptions] = useState('');
  const [confidence, setConfidence] = useState<'' | 'low' | 'medium' | 'high'>(''), [error, setError] = useState('');
  let bounds: string | null = null;
  try { const { low, high } = frechetBounds(percentToPpm(pA), percentToPpm(pB)); bounds = `Given these, "both" must be between ${pct(low)} and ${pct(high)}.`; } catch { bounds = null; }
  function submit(event: React.FormEvent) {
    event.preventDefault(); setError('');
    try { onSubmit(buildForecast({ pool: market.pool, a, b, pA, pB, pBoth, evidence: [evidence], assumptions, uncertainty, explanation, confidence })); }
    catch (e) { setError(message(e)); }
  }
  return <form className="agents-card agents-forecast" onSubmit={submit}>
    <h2>Your forecast</h2>
    <p className="agents-fine">Give your own probabilities for two events and how often they happen together. These are your estimates, kept separate from market prices.</p>
    <div className="agents-pair">
      <label>Event A<select value={a} onChange={e => setA(Number(e.target.value))}>{market.events.map(e => <option key={e.index} value={e.index} disabled={e.index === b}>{e.question}</option>)}</select></label>
      <label>Chance A happens (%)<input inputMode="decimal" value={pA} onChange={e => setPA(e.target.value)} placeholder="62" required/></label>
      <label>Event B<select value={b} onChange={e => setB(Number(e.target.value))}>{market.events.map(e => <option key={e.index} value={e.index} disabled={e.index === a}>{e.question}</option>)}</select></label>
      <label>Chance B happens (%)<input inputMode="decimal" value={pB} onChange={e => setPB(e.target.value)} placeholder="57" required/></label>
      <label className="agents-wide">Chance both happen (%)<input inputMode="decimal" value={pBoth} onChange={e => setPBoth(e.target.value)} placeholder="45" required/>
        <small>{bounds ?? 'Enter both chances to see the valid range for "both".'}</small></label>
    </div>
    <fieldset className="agents-evidence"><legend>Evidence</legend>
      <label>What you observed<input value={evidence.title} onChange={e => setEvidence({ ...evidence, title: e.target.value })} maxLength={160} required/></label>
      <label>Source<input value={evidence.source} onChange={e => setEvidence({ ...evidence, source: e.target.value })} maxLength={120} required/></label>
      <label>Link (optional, HTTPS)<input value={evidence.url} onChange={e => setEvidence({ ...evidence, url: e.target.value })} maxLength={512} placeholder="https://"/></label>
      <label>Observed at<input type="datetime-local" value={evidence.observedAt} onChange={e => setEvidence({ ...evidence, observedAt: e.target.value })} required/></label>
    </fieldset>
    <label>Why you expect this relationship<textarea value={explanation} onChange={e => setExplanation(e.target.value)} minLength={10} maxLength={1200} required/></label>
    <label>Uncertainty<input value={uncertainty} onChange={e => setUncertainty(e.target.value)} maxLength={600} required placeholder="What would change your view"/></label>
    <label>Assumptions (one per line, optional)<textarea value={assumptions} onChange={e => setAssumptions(e.target.value)} maxLength={2400}/></label>
    <label>Your own confidence (self-reported, not calibrated)<select value={confidence} onChange={e => setConfidence(e.target.value as never)}><option value="">Not stated</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
    {error && <p className="state-inline error" role="alert">{error}</p>}
    <button className="button button-dark" disabled={disabled}>Preview decision</button>
  </form>;
}

function DecisionCard({ record, questions, market, profile, busy, hasLiveProposal, paper, proposalAdded }: { record: RecordJSON; questions: string[]; market: Market; profile: ProfileJSON; busy: boolean; hasLiveProposal: boolean;
  paper: () => void; proposalAdded: (r: RecordJSON) => void }) {
  const d = record.decision, p = d.proposal, rel = d.relationship;
  const [now, setNow] = useState(Date.now() / 1000), [owner, setOwner] = useState(''), [error, setError] = useState(''), [working, setWorking] = useState(false);
  useEffect(() => { const t = setInterval(() => setNow(Date.now() / 1000), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { const c = new AbortController(); void linkedWallets(c.signal).then(v => setOwner(o => o || v.wallets[0] || '')).catch(() => {}); return () => c.abort(); }, []);
  const expired = p && now >= p.quoteExpiresAt;
  return <section className="agents-card agents-decision" aria-label="Latest decision">
    <div className="agents-row"><h2>{d.outcome === 'propose' ? 'Proposed purchase' : 'Abstained'}</h2><span className="market-badge">Snapshot block {d.snapshot.blockNumber}</span></div>
    <p>{d.explanation}</p>
    {d.outcome === 'abstain' && <ul className="agents-reasons">{d.reasons.map((r: string) => <li key={r}>{REASONS[r] ?? r}</li>)}</ul>}
    {rel && <div className="agents-compare">
      <div><span>Your chance both happen</span><strong>{pct(rel.forecastBothPpm)}</strong></div>
      <div><span>If they were unrelated (your marginals)</span><strong>{pct(rel.forecastIndependentPpm)}</strong></div>
      <div><span>Pool-implied chance both happen</span><strong>{rel.impliedAvailable ? tenths(rel.impliedBothTenths) : 'Unavailable'}</strong></div>
    </div>}
    {p && <>
      <h3>{describeClaim(p.claim.scope, Number(p.claim.mask), questions)}</h3>
      <p className="agents-fine">Wins if: {p.winning.map((combo: { event: number; yes: boolean }[]) => combo.map(x => `${questions[x.event]} ${x.yes ? 'Yes' : 'No'}`).join(' and ')).join('; or ')}.</p>
      <dl className="agents-terms">
        <dt>Your forecast that it pays</dt><dd>{pct(p.forecastPpm)}</dd>
        <dt>Pool model-implied chance</dt><dd>{record.proposalImplied ? tenths(record.proposalImplied.marketTenths) : 'Unavailable'}</dd>
        <dt>Average price per share at this size</dt><dd>{pct(p.averagePricePpm)} (a finite-size cost, not a probability)</dd>
        <dt>Quantity</dt><dd>{amount(p.quantityAtoms)} share(s)</dd>
        <dt>Quoted cost</dt><dd>{amount(p.quoteAtoms)} test AUSD</dd>
        <dt>Most you would pay</dt><dd>{amount(p.worstCostAtoms)} test AUSD ({p.slippageBps / 100}% slippage allowance)</dd>
        <dt>Pays if it wins outright</dt><dd>{amount(p.quantityAtoms)} test AUSD. VOID events pay a fraction under the published rules.</dd>
        <dt>Estimated edge under your forecast</dt><dd>{amount(p.edgeAtoms)} test AUSD before gas</dd>
        <dt>Quote valid until</dt><dd>{expired ? 'Expired. Preview again for a fresh quote.' : when(p.quoteExpiresAt)}</dd>
      </dl>
      <details className="agents-assumptions"><summary>Assumptions</summary><ul>{d.assumptions.map((a: string) => <li key={a}>{a}</li>)}</ul></details>
      <div className="agents-actions">
        <button className="button button-outline" disabled={busy || expired} onClick={paper}>Record paper trade</button>
        {profile.mode === 'approval' && <>
          <label className="agents-inline">MetaMask wallet<LinkedWalletSelect value={owner} onChange={setOwner}/></label>
          {hasLiveProposal && <span className="agents-fine">A proposal from this decision is in progress or confirmed. Preview again for a new decision.</span>}
          <button className="button button-dark" disabled={busy || working || !owner || market.open === false || hasLiveProposal} onClick={async () => {
            setWorking(true); setError('');
            try { proposalAdded(await agentClient.agents.propose(profile.id, record.id, owner) as RecordJSON); }
            catch (e) { setError(message(e)); } finally { setWorking(false); }
          }}>{working ? 'Preparing...' : 'Prepare for MetaMask approval'}</button>
        </>}
      </div>
      {error && <p className="state-inline error" role="alert">{error}</p>}
    </>}
  </section>;
}

function LinkedWalletSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [wallets, setWallets] = useState<string[]>([]);
  useEffect(() => { const c = new AbortController(); void linkedWallets(c.signal).then(v => setWallets(v.wallets)).catch(() => {}); return () => c.abort(); }, []);
  if (!wallets.length) return <span className="agents-fine">No linked MetaMask wallet. <Link href="/markets" className="text-link">Link one on Markets</Link></span>;
  return <select value={value} onChange={e => onChange(e.target.value)}>{wallets.map(w => <option key={w} value={w}>{w.slice(0, 8)}...{w.slice(-6)}</option>)}</select>;
}

// User-approved execution through the existing review, submission and recovery flow. The agent never signs.
// A hash from MetaMask is kept in this browser until the server has durably recorded it against the
// matching proposal and resolved it, so a failed request or a reload never loses a sent transaction.
function Approvals({ id, profile, records, setRecords, questions, login, reload }: { id: string; profile: ProfileJSON; records: RecordJSON[];
  setRecords: (f: (r: RecordJSON[]) => RecordJSON[]) => void; questions: string[]; login: string; reload: () => Promise<void> }) {
  const namespace = profile.market.namespace as PilotNamespace;
  const [wallets, setWallets] = useState<BrowserWallet[]>([]), [connection, setConnection] = useState<TradingConnection>({ owner: '', status: 'checking' });
  const [pending, setPending] = useState<PilotPending | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [hash, setHash] = useState('');
  const [semanticFailure, setSemanticFailure] = useState<{recordId:string; original:unknown; review:PilotReview} | null>(null);
  const provider = useRef<BrowserWallet['provider'] | null>(null), live = useRef(true), resumed = useRef(new Set<string>());
  const replace = (r: RecordJSON) => setRecords(list => list.map(x => (x.id === r.id ? r : x)));
  const save = (value: PilotPending | null) => { if (value) localStorage.setItem(pendingKeyFor(namespace), JSON.stringify(value)); else localStorage.removeItem(pendingKeyFor(namespace)); setPending(value); };
  useEffect(() => { live.current = true; const stop = discoverWallets(w => setWallets(old => (old.some(x => x.provider === w.provider) ? old : [...old, w])));
    try { setPending(readPilotPending(namespace)); } catch { setError('Saved transaction tracking is invalid. Do not resubmit; check your wallet activity.'); }
    return () => { live.current = false; stop(); }; }, [namespace]);
  // A verified linked MetaMask wallet restores silently (eth_accounts). Any wallet or account change
  // discards the connection and every prepared review must be checked against it again.
  useEffect(() => { const p = wallets[0]?.provider; if (!p || !login) { setConnection({ owner: '', status: 'disconnected' }); return; }
    return watchTradingWallet({ provider: p, account: login, links: linkedWallets, publish: value => { if (!live.current) return; provider.current = value.owner ? p : null; setConnection(value); } }); }, [wallets[0]?.provider, login]);

  // Reconcile the local record with this agent's proposals.
  const mine = pending ? records.find(r => belongsTo(r, pending, login, profile.market.pool)) : undefined;
  const registered = mine && pending?.hash ? mine.transactions.find((t: any) => t.hash === pending.hash) : undefined;
  const other = mine?.transactions.find((t: any) => t.status === 'submitted' && t.hash !== pending?.hash);
  // Expiry, dismissal or archiving does not prove a review was never sent, so the server accepts the hash
  // for any review the proposal issued; only another tracked transaction is a conflict.
  const recovery = !pending ? 'none' : !mine ? 'elsewhere' : !pending.hash ? 'no-hash' : registered ? (registered.status === 'submitted' ? 'tracked' : 'resolved')
    : other ? 'conflict' : 'unregistered';
  const archived = profile.status === 'archived';
  const open = records.filter(r => r.kind === 'proposal' && (OPEN.includes(r.status) || r.id === mine?.id));

  async function run(fn: () => Promise<void>) { setBusy(true); setError(''); try { await fn(); } catch (e) { setError(message(e)); } finally { if (live.current) setBusy(false); } }
  // Idempotent: the server accepts the same hash for the same reviewed transaction again.
  async function register(record: RecordJSON, saved: PilotPending) {
    try { replace(await agentClient.agents.track(id, record.id, { action: 'submitted', hash: saved.hash, transaction: saved.review.transaction }) as RecordJSON); }
    catch (e) {
      await reload().catch(() => {});
      throw new Error(`MetaMask sent this transaction (${short(saved.hash!)}), but the agent could not record it yet: ${message(e)} Do not send it again. Use Resume tracking.`);
    }
  }
  // Forget the local record only once the server holds this hash and has resolved it.
  useEffect(() => {
    if (!pending) return;
    if (recovery === 'resolved') {
      const current = localStorage.getItem(pendingKeyFor(namespace));
      if (current !== JSON.stringify(pending)) return;
      if (registered.status === 'confirmed' && !registered.attributedElsewhere) rememberConfirmedClaim(namespace, pending);
      save(null);
    } else if (recovery === 'unregistered' && !busy && !resumed.current.has(pending.hash!)) {
      resumed.current.add(pending.hash!);
      void run(() => register(mine!, pending));
    }
  }, [recovery, pending?.hash, mine?.id, registered?.status]);

  if (!open.length && !pending) return null;
  async function approve(record: RecordJSON) {
    setSemanticFailure(null);
    if (connection.owner !== record.owner) throw new Error('Select the MetaMask wallet this proposal was prepared for. Wallet changes need a new review.');
    if (!provider.current || !navigator.locks) throw new Error('MetaMask and Web Locks are required.');
    const review = record.review as PilotReview; validatePilotReview(review);
    await navigator.locks.request('flurbo-pilot-submit', { ifAvailable: true }, async lock => {
      if (!lock || readPilotPending(namespace)) throw new Error('Another transaction for this market is being tracked. Finish it first.');
      try { await submitPilot(provider.current as never, review, login, save, () => live.current && connection.owner === record.owner, {namespace}); }
      catch (e) {
        if (e instanceof PurchaseSemanticCollision) {
          setSemanticFailure({recordId:record.id, original:record.review, review:{...review, semanticAssessment:e.assessment}});
          return;
        }
        if (message(e) === 'Wallet request rejected.') replace(await agentClient.agents.track(id, record.id, { action: 'rejected' }) as RecordJSON);
        throw e;
      }
    });
    const saved = readPilotPending(namespace);
    if (saved?.hash) { resumed.current.add(saved.hash); await register(record, saved); }
  }
  async function check(record: RecordJSON) {
    const saved = readPilotPending(namespace);
    if (saved?.hash && belongsTo(record, saved, login, profile.market.pool) && !record.transactions.some((t: any) => t.hash === saved.hash)) await register(record, saved);
    const updated = await agentClient.agents.track(id, record.id, { action: 'check' }) as RecordJSON & { check?: string };
    replace(updated);
    if (updated.check) throw new Error(updated.check === 'unknown' ? 'The network has not seen this transaction yet.' : 'Waiting for confirmation.');
  }
  return <section className="agents-card" aria-label="Awaiting approval">
    <h2>Approvals</h2>
    <p className="agents-fine">MetaMask: {connection.status === 'connected' ? `connected with ${connection.owner.slice(0, 8)}...` : connection.status === 'unlinked' ? 'the selected wallet is not linked to this account' : connection.status === 'checking' ? 'checking...' : 'not connected'}. Approving a token allowance is not a purchase, and a transaction hash is not a confirmation.</p>
    {recovery === 'elsewhere' && <p className="agents-note" role="status">A transaction for this market is being tracked elsewhere: on the market page, by another agent, or by an archived agent. Finish it there before approving another.</p>}
    {recovery === 'no-hash' && mine && <div className="agents-attach"><p>MetaMask did not report the outcome. Do not approve again. Paste the transaction hash from MetaMask activity.</p>
      <input aria-label="Transaction hash" value={hash} onChange={e => setHash(e.target.value.trim())} placeholder="0x..."/>
      <button className="button button-outline" disabled={busy || !/^0x[0-9a-fA-F]{64}$/.test(hash)} onClick={() => run(async () => { const saved = { ...pending!, hash: hash.toLowerCase() as `0x${string}` };
        save(saved); resumed.current.add(saved.hash); await register(mine, saved); })}>Track this hash</button></div>}
    {recovery === 'unregistered' && mine && <div className="agents-attach" role="status"><p>MetaMask sent {short(pending!.hash!)} for this proposal, but the agent has not recorded it yet. Do not send it again.</p>
      <button className="button button-outline" disabled={busy} onClick={() => run(() => register(mine, pending!))}>Resume tracking</button></div>}
    {recovery === 'conflict' && mine && <div className="agents-attach" role="alert"><p>This browser sent {short(pending!.hash!)}, but the proposal already tracks {short(other.hash)}. Both may have been sent. Check that one first and do not send again; this hash can be recorded after it resolves.</p>
      <button className="button button-outline" disabled={busy} onClick={() => save(null)}>I checked wallet activity. Forget this local record</button></div>}
    <ul className="agents-proposals">{open.map(r => { const review = r.review as ReviewJSON | null; const blocked = busy || !!pending; return <li key={r.id}>
      <strong>{describeClaim(r.claim.scope, Number(r.claim.mask), questions)}</strong>
      <span>{STATUS[r.status] ?? r.status}</span>
      {review && <span className="agents-fine">{review.action === 'approve' ? `Step 1: approve exactly ${amount(review.amountAtoms)} test AUSD for the pool.` : `Buy ${amount(r.quantityAtoms)} share(s), paying at most ${amount(review.amountAtoms)} test AUSD.`} Wallet {r.owner.slice(0, 8)}...{r.owner.slice(-6)}. Review valid until {when(review.expiresAt)}.</span>}
      {r.transactions?.length > 0 && <span className="agents-fine">Tracked transaction {short(r.transactions.at(-1).hash)}.</span>}
      {semanticFailure?.recordId === r.id && semanticFailure.original === r.review && <SemanticReview review={semanticFailure.review} phrase="" onChange={() => {}} allowManualOverride={false}/>}
      <div className="agents-actions">
        {!archived && r.status === 'awaiting-approval' && <button className="button button-dark" disabled={blocked} onClick={() => run(() => approve(r))}>{review?.action === 'approve' ? 'Approve allowance in MetaMask' : 'Confirm purchase in MetaMask'}</button>}
        {r.status === 'submitted' && <button className="button button-outline" disabled={busy} onClick={() => run(() => check(r))}>Check confirmation</button>}
        {!archived && ['approval-confirmed', 'awaiting-approval', 'expired'].includes(r.status) && <button className="button button-outline" disabled={blocked} onClick={() => run(async () => replace(await agentClient.agents.track(id, r.id, { action: 'refresh' }) as RecordJSON))}>{r.status === 'approval-confirmed' ? 'Prepare the purchase' : 'Refresh review'}</button>}
        {!archived && ['approval-confirmed', 'expired'].includes(r.status) && <button className="button button-outline" disabled={blocked} onClick={() => run(async () => replace(await agentClient.agents.track(id, r.id, { action: 'rejected' }) as RecordJSON))}>Dismiss</button>}
      </div>
    </li>; })}</ul>
    {error && <p className="state-inline error" role="alert">{error}</p>}
  </section>;
}

function Performance({ data }: { data: any }) {
  const paper = data.paper, live = data.live, a = (v: string | null) => (v === null ? 'Unknown' : `${amount(v)} test AUSD`);
  return <div className="agents-performance">
    <div><h3>Paper (simulated)</h3><dl>
      <dt>Paper fills</dt><dd>{paper.fills}{paper.complete === false ? ' (incomplete)' : ''}</dd><dt>Paper cost</dt><dd>{a(paper.costBasisAtoms)}</dd>
      <dt>Realized result</dt><dd>{paper.realized ? a(paper.realized.pnlAtoms) : 'Not realized yet'}</dd>
      <dt>Open value</dt><dd>{paper.unrealized ? a(paper.unrealized.valueAtoms) : 'Unknown'}</dd></dl>
      {paper.missing.map((m: string) => <p key={m} className="agents-fine">{m}</p>)}</div>
    <div><h3>On-chain, agent-originated</h3><dl>
      <dt>Confirmed purchases</dt><dd>{live.confirmedPurchases}{live.complete === false ? ' (incomplete)' : ''}</dd><dt>Paid</dt><dd>{a(live.costBasisAtoms)}</dd>
      <dt>Realized result</dt><dd>Shown per wallet in Portfolio</dd><dt>Collected payouts</dt><dd><Link href="/portfolio" className="text-link">Collect in Portfolio</Link></dd></dl>
      {live.missing.map((m: string) => <p key={m} className="agents-fine">{m}</p>)}</div>
  </div>;
}

function Activity({ records, questions }: { records: RecordJSON[]; questions: string[] }) {
  if (!records.length) return null;
  return <section className="agents-card" aria-label="Activity"><h2>Activity</h2><ol className="agents-activity">{records.map(r => <li key={r.id}>
    <time>{when(r.createdAt)}</time>
    {r.kind === 'decision' && <span>{r.decision.outcome === 'propose' ? `Proposed ${describeClaim(r.decision.proposal.claim.scope, Number(r.decision.proposal.claim.mask), questions)}` : `Abstained: ${r.decision.reasons.map((x: string) => REASONS[x] ?? x).join(' ')}`}</span>}
    {r.kind === 'paper' && <span><strong>Paper trade recorded</strong> (simulated, not on-chain): {describeClaim(r.fill.claim.scope, Number(r.fill.claim.mask), questions)} at {amount(r.fill.costAtoms)} test AUSD</span>}
    {r.kind === 'proposal' && <span>{STATUS[r.status] ?? r.status}: {describeClaim(r.claim.scope, Number(r.claim.mask), questions)}{r.transactions?.length ? ` (${r.transactions.at(-1).hash.slice(0, 10)}...)` : ''}</span>}
  </li>)}</ol></section>;
}
