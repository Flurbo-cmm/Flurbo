import { useCallback, useEffect, useState } from 'react';
import AgentFunding from './AgentFunding';
import { ArrowLeft, Copy } from 'lucide-react';
import StatusBadge from '../components/ui/StatusBadge';
import Stepper, { type Step } from '../components/ui/Stepper';
import { useLoadGate } from '../loading/gates';
import { Link, useLocation } from 'wouter';
import { runtimeAdmin, agentClient, message, type ProfileJSON } from '../agents-client';
import { describeClaim, amount } from '../portfolio';
import { parseDecimal } from '../../../../packages/sdk/src/index.ts';
import { researchBlock } from '../agent-research';
import type { PilotNamespace } from '../pilot';

// Agents that run on the user's own infrastructure. This page configures them and shows what they report
// and what Flurbo verified. It does not run them: closing it does not stop a runtime.
const SCOPES = [
  ['markets:read', 'Read markets, quotes and analytics'], ['wallet:read', 'Read the agent wallet balances and positions'],
  ['runtime:report', 'Send heartbeats and decisions, read the policy'], ['executions:report', 'Report sent transactions for verification'],
] as const;
const CONNECTION: Record<string, string> = {
  connected: 'Runtime running', stale: 'No heartbeat for over 90 seconds: the runtime may be slow, offline or stopped',
  disconnected: 'Not running: no heartbeat for over 10 minutes', stopped: 'Stopped by its runtime', never: 'The runtime has not connected yet',
};
// Only a runtime that is still sending heartbeats is shown in its reported state; otherwise the report is history.
const reportedState = (state: string, connection: string) => connection === 'connected' || connection === 'stopped' ? state : `last reported ${state}`;
const EXECUTION: Record<string, string> = {
  recorded: 'Reported, not yet seen on-chain', pending: 'On-chain, waiting for confirmation', confirmed: 'Verified on-chain',
  reverted: 'Reverted on-chain', mismatch: 'Not attributed: the chain does not show the reported trade from this wallet', 'attributed-elsewhere': 'Verified for another agent or proposal first',
};
const REASON: Record<string, string> = {
  insufficient_evidence: 'Not enough fresh evidence', edge_below_threshold: 'No claim clears the minimum edge', model_abstained: 'The model declined to forecast',
  malformed_output: 'The model output failed validation', stale_evidence: 'Evidence too old', no_sources: 'No evidence could be retrieved',
  provider_not_configured: 'No research provider configured', request_budget_exhausted: 'Research budget used up', paused: 'Paused on Flurbo',
  live_disabled: 'Live trades not allowed on Flurbo', local_paper_mode: 'The runtime is in paper mode', policy_stale: 'The runtime could not read the current policy',
  market_closed: 'Trading is closed', budget_exceeded: 'Over the per-trade budget',
};
const when = (s: number | null | undefined) => (s ? new Date(s * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Never');
const ago = (s: number | null) => (s === null ? '' : s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`);
const short = (x: string) => `${x.slice(0, 10)}...${x.slice(-6)}`;
const pct = (ppm: bigint) => `${(Number(ppm) / 10_000).toFixed(1)}%`;

export function RuntimeCreateForm({ directory }: { directory: { namespace: string; label: string; open?:boolean }[] }) {
  const [name, setName] = useState(''), [markets, setMarkets] = useState<string[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [, navigate] = useLocation();
  useEffect(() => { setMarkets(m => (m.length ? m : directory.filter(d=>d.open).slice(0, 1).map(d => d.namespace))); }, [directory]);
  async function create(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { navigate(`/agents/${(await runtimeAdmin.create(name, markets)).id}`); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <form className="agents-card agents-register" id="register-agent" onSubmit={create} aria-label="Register an agent">
    <h2>Register an agent</h2><ol className="agent-setup-steps"><li>Name your agent and choose its markets.</li><li>Associate a dedicated wallet and create a credential.</li><li>Run the SDK in paper mode, then review its activity.</li></ol>
    <p className="agents-fine">Your agent runs on your own computer or server with the Flurbo SDK. It researches, forecasts and trades with its own dedicated wallet, within limits you set. Flurbo shows its status, decisions and verified trades here. By default it stops trading 120 seconds before a market closes.</p>
    <label>Name<input value={name} onChange={e => setName(e.target.value)} maxLength={48} required placeholder="Release relationship agent"/></label>
    <fieldset className="agents-choice"><legend>Related markets it may trade</legend>
      {directory.map(d => <label key={d.namespace}><input type="checkbox" checked={markets.includes(d.namespace)} disabled={!d.open} onChange={e => setMarkets(m => (e.target.checked ? [...m, d.namespace] : m.filter(x => x !== d.namespace)))}/>{d.label}<small>{d.open?'Open for predictions':'Unavailable for new trades'}</small></label>)}
    </fieldset>
    {error && <p className="state-inline error" role="alert">{error}</p>}
    <button className="btn btn-primary" disabled={busy || !markets.length}>{busy ? 'Registering...' : 'Register agent'}</button>
  </form>;
}

export function RuntimeAgentDetail({ id }: { id: string }) {
  const [view,setView]=useState('Overview');
  const [data, setData] = useState<any>(null), [questions, setQuestions] = useState<Record<string, string[]>>({}), [sources, setSources] = useState<Record<string, (string | null)[]>>({}), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const d = await runtimeAdmin.get(id);
    setData(d);
    for (const ns of d.profile.markets ?? []) if (!questions[ns]) agentClient.market(ns as PilotNamespace).then(m => { setQuestions(q => ({ ...q, [ns]: m.events.map(e => e.question) })); setSources(x => ({ ...x, [ns]: m.events.map(e => e.source?.referenceUrl ?? null) })); }).catch(() => {});
  }, [id]);
  useEffect(() => {
    let live = true;
    const tick = () => load().catch(e => { if (live) setError(message(e)); });
    void tick();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void tick(); }, 15_000);
    // Polling pauses while the tab is hidden (for example while a terminal runs the agent), so read at once on return.
    const back = () => { if (document.visibilityState === 'visible') void tick(); };
    document.addEventListener('visibilitychange', back);
    return () => { live = false; clearInterval(timer); document.removeEventListener('visibilitychange', back); };
  }, [load]);
  async function act(fn: () => Promise<unknown>) { setBusy(true); setError(''); try { await fn(); await load(); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  useLoadGate('agent-runtime', { pending: !data && !error, error: !data ? error : null, label: 'Loading your agent' });
  if (!data) return error ? <><p className="state-inline error" role="alert">{error}</p><Link href="/agents" className="link-back"><ArrowLeft aria-hidden="true" strokeWidth={1.75}/>All agents</Link></> : <><p role="status" className="sr-only">Loading agent...</p><div className="agents-skeleton" aria-hidden="true"><span className="skeleton" style={{ height: 36, width: '40%' }}/><span className="skeleton" style={{ height: 88 }}/><span className="skeleton" style={{ height: 240 }}/></div></>;
  const profile: ProfileJSON = data.profile, rt = data.runtime, policy = rt.policy, archived = profile.status === 'archived';
  const latest = rt.heartbeats[0] ?? null;
  return <>
    <nav className="agents-back"><Link href="/agents" className="link-back"><ArrowLeft aria-hidden="true" strokeWidth={1.75}/>All agents</Link></nav>
    <header className="agents-profile">
      <div className="agents-profile-title"><span className="chip">Runs on your infrastructure</span>
        <h1>{profile.name}</h1>
        <p>Closing this page does not stop the agent. Stop it where it runs with <code>flurbo-agent stop</code> or Ctrl+C.</p></div>
      <dl className="agents-facts">
        <div><dt>Flurbo policy</dt><dd><StatusBadge kind={archived ? 'closed' : policy.paused ? 'waiting' : policy.liveEnabled ? 'open' : 'settled'}>{archived ? 'Archived' : policy.paused ? 'Paused on Flurbo' : policy.liveEnabled ? 'Live trades allowed' : 'Paper until allowed'}</StatusBadge></dd></div>
        <div><dt>Last reported by your runtime</dt><dd>{latest ? `${latest.mode === 'live' ? 'Live' : 'Paper'} mode, ${reportedState(latest.state, rt.connection.state)}` : 'No report yet'}<small>{CONNECTION[rt.connection.state]}{rt.connection.ageSeconds !== null && rt.connection.state !== 'never' ? `, ${ago(rt.connection.ageSeconds)}` : ''}</small></dd></div>
        <div><dt>Verified on-chain</dt><dd>{rt.totals.buys} {rt.totals.buys === 1 ? 'purchase' : 'purchases'}<small>{rt.totals.sells} sales, {rt.totals.redemptions} redemptions</small></dd></div>
      </dl>
    </header>
    {error && <p className="state-inline error" role="alert">{error}</p>}
    {archived && <p className="agents-note" role="status">This agent is archived. Its credentials cannot start new work; a runtime can still report transactions it already sent so they are verified and counted once.</p>}
    <nav className="agent-navigation tabs" aria-label="Agent sections">{['Overview','Activity','Setup','Settings'].map(v=><button key={v} type="button" aria-pressed={view===v} disabled={busy} onClick={()=>setView(v)}>{v}</button>)}</nav>
    {!profile.wallet&&view==='Overview'&&<div className="agents-note"><strong>Finish setting up your agent</strong><p>Associate its wallet, issue a credential and run it in paper mode.</p><button className="btn btn-primary" onClick={()=>setView('Setup')}>Continue setup</button></div>}
    <div hidden={view!=='Overview'}><section className="agents-card" aria-label="Runtime status">
      <div className="agents-row"><h2>Runtime</h2><span className={`agents-chip agents-chip-${rt.connection.state}`} data-state={rt.connection.state}>{CONNECTION[rt.connection.state]}{rt.connection.ageSeconds !== null && rt.connection.state !== 'never' ? `, last heartbeat ${ago(rt.connection.ageSeconds)}` : ''}</span></div>
      {latest ? <dl className="agents-terms">
        <dt>Last reported mode (not a live confirmation)</dt><dd>{latest.mode === 'live' ? 'Live testnet trades' : 'Paper (simulated)'}; {reportedState(latest.state, rt.connection.state)}</dd>
        <dt>SDK</dt><dd>{latest.sdk.language} {latest.sdk.version}</dd>
        <dt>Transactions in progress</dt><dd>{latest.pending}</dd>
        <dt>Policy</dt><dd>{rt.acknowledged ? `Applies Flurbo policy version ${policy.version}` : `Has not applied policy version ${policy.version} yet (applies ${latest.policy.flurboVersion ?? 'none'})`}</dd>
        <dt>Local limits reported</dt><dd>{latest.policy.summary?.maxTradeCostAtoms ? `${amount(latest.policy.summary.maxTradeCostAtoms)} test AUSD per trade` : 'Not reported'}{latest.policy.summary?.totalAtoms ? `, ${amount(latest.policy.summary.totalAtoms)} total` : ''}</dd>
        {latest.lastErrorCode && <><dt>Last error</dt><dd>{latest.lastErrorCode}</dd></>}
      </dl> : <p className="agents-fine">Open Setup for instructions to start the runtime. It appears here after its first heartbeat.</p>}
    </section>
    <Verified id={id} rt={rt} questions={questions} busy={busy} act={act}/></div>
    <div hidden={view!=='Setup'} className="agents-setup"><h2>Set up your agent</h2><p className="agents-fine">Complete these steps in order. Keep paper mode on until you have checked its decisions.</p>
    <Stepper className="agents-checklist" label="Setup progress" steps={setupSteps(profile, rt)}/>
    {!archived && <WalletSetup id={id} profile={profile} busy={busy} act={act}/>}
    {!archived && <Credentials id={id} credentials={rt.credentials} busy={busy} act={act}/>}
    {!archived && <Setup profile={profile} hasWallet={!!profile.wallet}/>}
    {!archived && <ResearchSetup markets={profile.markets ?? []} questions={questions} sources={sources}/>}
    </div><div hidden={view!=='Activity'}><Decisions decisions={rt.decisions} questions={questions}/>{!rt.decisions.length&&<p>No decisions yet. Start the agent in paper mode from Setup.</p>}</div>
    <div hidden={view!=='Settings'}>{!archived&&<><Controls id={id} policy={policy} busy={busy} act={act}/><Archive id={id} busy={busy} act={act}/></>}{archived&&<p>This agent is archived. Its verified activity remains available.</p>}</div>
  </>;
}

function Controls({ id, policy, busy, act }: { id: string; policy: any; busy: boolean; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [limit, setLimit] = useState(policy.limits.maxTradeCostAtoms ? amount(policy.limits.maxTradeCostAtoms) : ''), [daily, setDaily] = useState(policy.limits.windows[0] ? amount(policy.limits.windows[0].atoms) : '');
  const [error, setError] = useState(''), [confirmLive, setConfirmLive] = useState(false);
  const save = () => { setError(''); try {
    const maxTradeCostAtoms = limit.trim() ? parseDecimal(limit.trim(), 6).toString() : null, windows = daily.trim() ? [{ seconds: 86_400, atoms: parseDecimal(daily.trim(), 6).toString() }] : [];
    void act(() => runtimeAdmin.setPolicy(id, { maxTradeCostAtoms, windows }));
  } catch (e) { setError(message(e)); } };
  return <section className="agents-card" aria-label="Controls">
    <h2>Controls</h2>
    <div className="agents-actions">
      <button className="button button-outline" disabled={busy} onClick={() => act(() => runtimeAdmin.setPolicy(id, { paused: !policy.paused }))}>{policy.paused ? 'Resume new actions' : 'Pause new actions'}</button>
      <button className="button button-outline" disabled={busy || confirmLive} onClick={() => policy.liveEnabled ? act(() => runtimeAdmin.setPolicy(id, { liveEnabled: false })) : setConfirmLive(true)}>{policy.liveEnabled ? 'Stop allowing live trades' : 'Allow live testnet trades'}</button>
    </div>
    {confirmLive && !policy.liveEnabled && <div className="agents-confirm" role="group" aria-label="Confirm live testnet trades">
      <p><strong>Allow this agent to send live testnet trades?</strong></p>
      <p className="agents-fine">Its runtime can then spend test AUSD from the agent wallet on its own, within these Flurbo limits: {!policy.limits.maxTradeCostAtoms && !policy.limits.windows.length ? 'the defaults, 2 test AUSD per trade and 10 test AUSD per 24 hours' : <>{policy.limits.maxTradeCostAtoms ? `${amount(policy.limits.maxTradeCostAtoms)} test AUSD per trade` : 'no per-trade limit'}; {policy.limits.windows[0] ? `${amount(policy.limits.windows[0].atoms)} test AUSD per 24 hours` : 'no 24-hour limit'}</>}. The runtime also keeps its own local limits, and every trade must pass both. The runtime must be set to "mode": "live". You can stop it at any time.</p>
      <div className="agents-actions"><button className="btn btn-primary" disabled={busy} onClick={() => act(async () => { await runtimeAdmin.setPolicy(id, { liveEnabled: true }); setConfirmLive(false); })}>Confirm live testnet trades</button><button className="btn btn-secondary" onClick={() => setConfirmLive(false)}>Cancel</button></div>
    </div>}
    <p className="agents-fine">Pause is an instruction. A compliant runtime reads it before each new action and stops starting trades within about a minute. It is not an on-chain freeze: a transaction already sent can still confirm, and the wallet key can still sign outside the runtime.</p>
    <p className="agents-fine">Live trades need both this setting and <code>"mode": "live"</code> in the runtime's own configuration. Until then it records paper decisions only. Currently: {policy.liveEnabled ? 'allowed here' : 'not allowed here'}.</p>
    <div className="agents-pair">
      <label>Most per trade, test AUSD (Flurbo limit)<input inputMode="decimal" value={limit} onChange={e => setLimit(e.target.value)} placeholder="No Flurbo limit"/></label>
      <label>Most per 24 hours, test AUSD<input inputMode="decimal" value={daily} onChange={e => setDaily(e.target.value)} placeholder="No Flurbo limit"/></label>
    </div>
    <p className="agents-fine">The runtime also stops trading 120 seconds before each market closes by default (<code>policy.minSecondsBeforeClose</code> in its configuration file), and skips that market with <code>too_close_to_close</code> in its log.</p>
    <p className="agents-fine">These limits only tighten the runtime's own limits. They are software checks in a compliant runtime; the amount in the agent wallet is the hard bound on what it can spend.</p>
    {error && <p className="state-inline error" role="alert">{error}</p>}
    <button className="button button-outline" disabled={busy} onClick={save}>Save limits</button>
  </section>;
}

function WalletSetup({ id, profile, busy, act }: { id: string; profile: ProfileJSON; busy: boolean; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [address, setAddress] = useState(''), [challenge, setChallenge] = useState<{ id: string; message: string; expiresAt: number } | null>(null), [signature, setSignature] = useState('');
  return <section className="agents-card" aria-label="Agent wallet">
    <h2>Agent wallet</h2>
    {profile.wallet ? <><p>Associated wallet <code>{profile.wallet}</code>. Only transactions this runtime reports from this wallet, verified on-chain, count for the agent.</p><AgentFunding wallet={profile.wallet}/></>
      : <p className="agents-fine">Use a new wallet only for this agent, funded with a small amount of test AUSD and MON for gas. Never a deployer, settlement, reviewer or personal wallet. Its key stays on your machine; Flurbo never asks for it.</p>}
    {(profile.walletHistory ?? []).length > 1 && <details className="agents-assumptions"><summary>Earlier wallets</summary><ul>{profile.walletHistory!.filter(w => w.until !== null).map(w => <li key={w.address + w.from}>{w.address}: {when(w.from)} to {when(w.until)}</li>)}</ul></details>}
    {!challenge ? <div className="agents-attach">
      <label>{profile.wallet ? 'Replace with wallet' : 'Wallet address'}<input value={address} onChange={e => setAddress(e.target.value.trim())} placeholder="0x..."/></label>
      <button className="button button-outline" disabled={busy || !/^0x[0-9a-fA-F]{40}$/.test(address)} onClick={() => act(async () => setChallenge(await runtimeAdmin.walletChallenge(id, address)))}>Get ownership message</button>
    </div> : <div className="agents-attach">
      <p className="agents-fine">Save this message to a file and sign it where the agent runs: <code>flurbo-agent sign-message --file message.txt</code>. It proves control of the wallet and authorizes nothing. It expires at {when(challenge.expiresAt)}.</p>
      <pre className="agents-code">{challenge.message}</pre>
      <button className="button button-outline" onClick={() => void navigator.clipboard?.writeText(challenge.message)}>Copy message</button>
      <label>Signature<input value={signature} onChange={e => setSignature(e.target.value.trim())} placeholder="0x..."/></label>
      <div className="agents-actions">
        <button className="button button-dark" disabled={busy || !/^0x[0-9a-fA-F]{130}$/.test(signature)} onClick={() => act(async () => { await runtimeAdmin.walletVerify(id, challenge.id, signature); setChallenge(null); setSignature(''); setAddress(''); })}>Verify and associate</button>
        <button className="button button-outline" onClick={() => setChallenge(null)}>Cancel</button>
      </div>
    </div>}
  </section>;
}

function Credentials({ id, credentials, busy, act }: { id: string; credentials: any[]; busy: boolean; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [scopes, setScopes] = useState<string[]>(SCOPES.map(s => s[0])), [ttl, setTtl] = useState(30), [label, setLabel] = useState(''), [issued, setIssued] = useState<string | null>(null), [confirm, setConfirm] = useState<string | null>(null);
  return <section className="agents-card" aria-label="API credentials">
    <h2>API credentials</h2>
    <p className="agents-fine">A credential lets the runtime read markets and report activity. It cannot sign or move funds. Revoking it stops a compliant runtime from starting new actions; it does not revoke the wallet's on-chain authority.</p>
    {issued && <div className="agents-note" role="status"><strong>Copy this token now. It is shown once.</strong><pre className="agents-code">{issued}</pre>
      <div className="agents-actions"><button className="button button-outline" onClick={() => void navigator.clipboard?.writeText(issued)}><Copy aria-hidden="true" strokeWidth={1.75}/>Copy token</button><button className="button button-outline" onClick={() => setIssued(null)}>I have stored it</button></div>
      <p className="agents-fine">Set it as <code>FLURBO_AGENT_TOKEN</code> in the runtime's environment. Never put it in a file you share, a URL or a prompt.</p></div>}
    {credentials.length > 0 && <ul className="agents-proposals">{credentials.map(c => <li key={c.credentialId}>
      <strong>{c.label || 'Credential'} <code>{c.preview}</code></strong>
      <span>{c.status === 'active' ? `Active, expires ${when(c.expiresAt)}` : c.status === 'revoked' ? `Revoked ${when(c.revokedAt)}` : 'Expired'}. Last used: {when(c.lastUsedAt)}.</span>
      <span className="agents-fine">{c.scopes.map((x: string) => SCOPES.find(sc => sc[0] === x)?.[1] ?? x).join('; ')}</span>
      {c.status === 'active' && <div className="agents-actions">
        {confirm === c.credentialId ? <><span className="agents-fine">Revoke now? The runtime stops starting new actions.</span>
          <button className="button button-dark" disabled={busy} onClick={() => act(async () => { await runtimeAdmin.revokeCredential(id, c.credentialId); setConfirm(null); })}>Confirm revoke</button>
          <button className="button button-outline" onClick={() => setConfirm(null)}>Keep</button></>
          : <><button className="button button-outline" disabled={busy} onClick={() => act(async () => setIssued((await runtimeAdmin.rotateCredential(id, c.credentialId)).token))}>Rotate</button>
            <button className="button button-outline" disabled={busy} onClick={() => setConfirm(c.credentialId)}>Revoke</button></>}
      </div>}
    </li>)}</ul>}
    <fieldset className="agents-choice"><legend>New credential</legend>
      {SCOPES.map(([scope, text]) => <label key={scope}><input type="checkbox" checked={scopes.includes(scope)} onChange={e => setScopes(s => (e.target.checked ? [...s, scope] : s.filter(x => x !== scope)))}/><span>{text}<small className="mono">{scope}</small></span></label>)}
    </fieldset>
    <div className="agents-pair">
      <label>Label<input value={label} onChange={e => setLabel(e.target.value)} maxLength={48} placeholder="home server"/></label>
      <label>Expires after (days)<input type="number" min={1} max={90} value={ttl} onChange={e => setTtl(Number(e.target.value))}/></label>
    </div>
    <button className="button button-dark" disabled={busy || !scopes.length} onClick={() => act(async () => setIssued((await runtimeAdmin.issueCredential(id, { scopes, ttlDays: ttl, label })).token))}>Issue credential</button>
  </section>;
}

function Setup({ profile, hasWallet }: { profile: ProfileJSON; hasWallet: boolean }) {
  const [language, setLanguage] = useState<'typescript' | 'python' | 'rust' | 'cpp'>('typescript');
  const [copyStatus,setCopyStatus]=useState('');
  const origin = typeof window === 'undefined' ? 'https://flurbo.singu.online' : window.location.origin;
  // init writes this agent's registered markets into the file, so it trades exactly what Flurbo allows.
  const markets = (profile.markets ?? []).join(',');
  const review = [
    `# init sets markets to ${markets || 'the ones listed on this page'}. Check api.baseUrl is "${origin}", then set`,
    '# research.provider (your model provider), strategy and policy. Keep "mode": "paper" until ready.',
    '# Agents stop trading 120 seconds before a market closes (policy.minSecondsBeforeClose).',
  ];
  const ts = [
    '# Node 24 or later, in your copy of the Flurbo SDK source',
    'cd packages/sdk && npm ci',
    `node bin/flurbo-agent.ts init --config flurbo-agent.json --markets ${markets}`,
    ...review,
    'export FLURBO_AGENT_TOKEN=...            # PowerShell: $env:FLURBO_AGENT_TOKEN="..."',
    'export FLURBO_AGENT_PRIVATE_KEY=...      # agent wallet key, live mode only',
    'export OPENAI_API_KEY=...                # or the variable your provider uses',
    'node bin/flurbo-agent.ts start --config flurbo-agent.json',
    'node bin/flurbo-agent.ts status --config flurbo-agent.json',
    'node bin/flurbo-agent.ts stop --config flurbo-agent.json',
  ].join('\n');
  const py = [
    '# Python 3.11 or later, in your copy of the Flurbo SDK source',
    'cd packages/sdk-python && python -m venv .venv',
    '# macOS / Linux: source .venv/bin/activate',
    '# Windows Git Bash: source .venv/Scripts/activate',
    '# Windows PowerShell: .venv\\Scripts\\Activate.ps1',
    'python -m pip install -e .',
    `python -m flurbo_sdk init --config flurbo-agent.json --markets ${markets}`,
    '# Same configuration format as TypeScript.',
    ...review,
    'export FLURBO_AGENT_TOKEN=...            # PowerShell: $env:FLURBO_AGENT_TOKEN="..."',
    'export FLURBO_AGENT_PRIVATE_KEY=...      # agent wallet key, live mode only',
    'python -m flurbo_sdk start --config flurbo-agent.json',
    'python -m flurbo_sdk status --config flurbo-agent.json',
    'python -m flurbo_sdk stop --config flurbo-agent.json',
  ].join('\n');
  const rs = [
    '# A Rust toolchain, in your copy of the Flurbo SDK source',
    'cd packages/sdk-rust && cargo build --release',
    `./target/release/flurbo-agent-rs init --config flurbo-agent.json --markets ${markets}`,
    '# Same configuration format as TypeScript.',
    ...review,
    'export FLURBO_AGENT_TOKEN=...            # PowerShell: $env:FLURBO_AGENT_TOKEN="..."',
    'export FLURBO_AGENT_PRIVATE_KEY=...      # agent wallet key, live mode only',
    './target/release/flurbo-agent-rs start --config flurbo-agent.json',
    './target/release/flurbo-agent-rs status --config flurbo-agent.json',
    './target/release/flurbo-agent-rs stop --config flurbo-agent.json',
  ].join('\n');
  const cpp = [
    '# GCC or Clang (C++20) and OpenSSL 3.2 or later, in your copy of the Flurbo SDK source',
    'cd packages/sdk-cpp && make            # Windows (MSYS2): mingw32-make',
    '# Windows: keep C:\\msys64\\ucrt64\\bin on PATH when you run it, or it exits at once (code 127) without a message',
    `./build/flurbo-agent-cpp init --config flurbo-agent.json --markets ${markets}`,
    '# Same configuration format as TypeScript.',
    ...review,
    'export FLURBO_AGENT_TOKEN=...            # PowerShell: $env:FLURBO_AGENT_TOKEN="..."',
    'export FLURBO_AGENT_PRIVATE_KEY=...      # agent wallet key, live mode only',
    './build/flurbo-agent-cpp start --config flurbo-agent.json',
    './build/flurbo-agent-cpp status --config flurbo-agent.json',
    './build/flurbo-agent-cpp stop --config flurbo-agent.json',
  ].join('\n');
  const available: Record<string, string> = { typescript: ts, python: py, rust: rs, cpp };
  return <section className="agents-card" aria-label="Run the agent">
    <h2>Run the agent</h2><p className="callout"><strong>New to this?</strong> Follow <Link href="/docs#first-bot">Your first trading bot, step by step</Link>. It explains every command below, why it is needed and what you should see, and starts safely in practice mode.</p><p className="agents-fine">These commands are for a terminal on your own computer, in a copy of the Flurbo SDK source. The source is not public yet; ask the Flurbo team for a copy through the channel where you received your invitation. <Link href="/docs#agents">Read the setup and troubleshooting guide</Link>.</p>
    <div className="agents-tabs segmented" role="tablist" aria-label="SDK language">{(['typescript', 'python', 'rust', 'cpp'] as const).map(l => <button key={l} type="button" role="tab" aria-selected={language === l} aria-pressed={language === l} onClick={() => setLanguage(l)}>{{ typescript: 'TypeScript', python: 'Python', rust: 'Rust', cpp: 'C++' }[l]}</button>)}</div>
    {!hasWallet && <p className="agents-note">Associate the agent wallet first; Flurbo only attributes trades from it.</p>}
    <pre className="agents-code">{available[language]}</pre>
    <button className="button button-outline" onClick={async()=>{try{await navigator.clipboard.writeText(available[language]);setCopyStatus('Commands copied.');}catch{setCopyStatus('Copy is unavailable. Select the commands above to copy them.');}}}><Copy aria-hidden="true" strokeWidth={1.75}/>Copy commands</button><span role="status" className="agents-fine"> {copyStatus}</span>
    <p className="agents-fine">The runtime keeps its journal in the state directory and resumes pending transactions after a restart without sending them twice. Each SDK's README in the source explains configuration and custom strategies.</p>
  </section>;
}

function ResearchSetup({ markets, questions, sources }: { markets: string[]; questions: Record<string, string[]>; sources: Record<string, (string | null)[]> }) {
  const [copyStatus, setCopyStatus] = useState('');
  if (!markets.length || markets.some(ns => !questions[ns])) return null;
  const block = researchBlock(markets, sources, Object.fromEntries(markets.map(ns => [ns, questions[ns].length])));
  return <section className="agents-card" aria-label="Research settings">
    <h2>Research settings for these markets</h2>
    <p className="agents-fine">Replace the <code>"research"</code> section of <code>flurbo-agent.json</code> with this, then set your model provider. It allows the sites that settlement reads and lets undated pages count as background evidence.</p>
    <pre className="agents-code">{block}</pre>
    <button className="button button-outline" onClick={async () => { try { await navigator.clipboard.writeText(block); setCopyStatus('Research settings copied.'); } catch { setCopyStatus('Copy is unavailable. Select the text above to copy it.'); } }}><Copy aria-hidden="true" strokeWidth={1.75}/>Copy research settings</button><span role="status" className="agents-fine"> {copyStatus}</span>
    <p className="agents-fine">Every question needs at least one readable page in each cycle, or the agent decides nothing. The runtime reads the record settlement reads for each question, listed below, but that record may not exist until the result is published, and chain endpoints answer JSON-RPC rather than page requests. For such a question, add a page about it under <code>extraSources</code>, for example <code>{'{ "event": 1, "url": "https://..." }'}</code>, and add its site to <code>allowHosts</code>. Pages over 2 MB are skipped.</p>
    <ul className="agents-fine">{markets.flatMap(ns => (questions[ns] ?? []).map((q, i) => <li key={ns + i}>Question {i} ({ns}): {q} Settlement reads: <code>{sources[ns]?.[i] ?? 'not listed'}</code></li>))}</ul>
  </section>;
}

function Verified({ id, rt, questions, busy, act }: { id: string; rt: any; questions: Record<string, string[]>; busy: boolean; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const t = rt.totals;
  return <section className="agents-card" aria-label="Verified trades">
    <div className="agents-row"><h2>Verified trades</h2><Link href="/portfolio" className="text-link">Account portfolio</Link></div>
    <dl className="agents-terms">
      <dt>Purchases</dt><dd>{t.buys}, paid {amount(t.buyCostAtoms)} test AUSD</dd>
      <dt>Sales</dt><dd>{t.sells}, received {amount(t.sellProceedsAtoms)} test AUSD</dd>
      <dt>Redemptions</dt><dd>{t.redemptions}, received {amount(t.redeemedAtoms)} test AUSD</dd>
      <dt>Reverted or not attributed</dt><dd>{t.reverted} reverted, {t.mismatched} not matching, {t.attributedElsewhere} attributed elsewhere</dd>
    </dl>
    <p className="agents-fine">Only transactions the runtime reported, sent from the agent wallet and verified on-chain by Flurbo count here. Gas is paid by the agent wallet and is not included. Other activity of the wallet is not agent performance.</p>
    {rt.executions.length > 0 && <ul className="agents-proposals">{rt.executions.map((e: any) => <li key={e.hash}>
      <strong>{e.intent.action === 'approve' ? `Approve ${amount(e.intent.limitAtoms)} test AUSD for the pool` : `${e.intent.action[0].toUpperCase()}${e.intent.action.slice(1)} ${amount(e.intent.quantityAtoms)} share(s): ${describeClaim(e.intent.claim.scope, Number(e.intent.claim.mask), questions[e.namespace])}`}</strong>
      <span>{EXECUTION[e.status] ?? e.status}{e.verification?.collateralAtoms ? `, ${amount(e.verification.collateralAtoms)} test AUSD` : ''}</span>
      <span className="agents-fine">Transaction {short(e.hash)}, reported {when(e.reportedAt)}{e.verification?.reason ? `, reason: ${e.verification.reason.replace(/_/g, ' ')}` : ''}</span>
      {['recorded', 'pending'].includes(e.status) && <div className="agents-actions"><button className="button button-outline" disabled={busy} onClick={() => act(() => runtimeAdmin.checkExecution(id, e.hash))}>Check again</button></div>}
    </li>)}</ul>}
  </section>;
}

function Decisions({ decisions, questions }: { decisions: any[]; questions: Record<string, string[]> }) {
  const [showAll,setShowAll]=useState(false);
  if (!decisions.length) return null;
  return <section className="agents-card" aria-label="Decisions">
    <h2>Decisions</h2>
    <p className="agents-fine">Reported by the runtime. Forecasts, evidence and reasons are the agent's own and are not verified by Flurbo.</p>
    <ol className="agents-activity">{(showAll?decisions:decisions.slice(0,5)).map(d => {
      const joint = d.forecast?.joint, s = joint?.statesPpm?.map((x: string) => BigInt(x));
      return <li key={d.decisionId}><time>{when(d.createdAt)}</time><div>
        <strong>{d.outcome === 'trade' ? 'Traded' : d.outcome === 'paper' ? 'Paper trade' : d.outcome === 'rejected_by_policy' ? 'Stopped by policy' : 'Abstained'}</strong>
        {d.reasons.length > 0 && <span> {d.reasons.map((r: string) => REASON[r] ?? r.replace(/_/g, ' ').toLowerCase()).join('; ')}.</span>}
        {s && s.length === 4 && <span className="agents-fine"> Forecast: {questions[d.namespace]?.[joint.events[0]]||`Question ${joint.events[0]+1}`} {pct(s[1] + s[3])}, {questions[d.namespace]?.[joint.events[1]]||`Question ${joint.events[1]+1}`} {pct(s[2] + s[3])}, both {pct(s[3])}.</span>}
        {d.candidate && <span className="agents-fine"> Claim: {describeClaim(d.candidate.claim.scope, Number(d.candidate.claim.mask), questions[d.namespace])}, quote {amount(d.candidate.quoteAtoms)} test AUSD.</span>}
        <span className="agents-fine"> Source: {d.provenance.kind === 'model' ? `model ${d.provenance.name}` : d.provenance.kind === 'fixture' ? `fixture ${d.provenance.name} (not AI)` : d.provenance.name}.</span>
        {d.forecast?.evidence?.length > 0 && <details className="agents-assumptions"><summary>Evidence ({d.forecast.evidence.length})</summary><ul className="agents-evidence-list">{d.forecast.evidence.map((e: any) => <li key={e.id}>{e.url ? <a href={e.url} rel="noreferrer noopener" target="_blank">{e.title}</a> : <span>{e.title}</span>}<small>{e.source}, {new Date(e.observedAt).toLocaleDateString()}</small></li>)}</ul></details>}
      </div></li>;
    })}</ol>{decisions.length>5&&<button className="button button-outline" onClick={()=>setShowAll(v=>!v)}>{showAll?'Show recent only':`Show all ${decisions.length} decisions`}</button>}
  </section>;
}

function Archive({ id, busy, act }: { id: string; busy: boolean; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [confirm, setConfirm] = useState(false), [, navigate] = useLocation();
  return <section className="agents-card" aria-label="Archive">
    <h2>Archive</h2>
    <p className="agents-fine">Archiving stops credentials from starting new work and frees the wallet. Verified trades and the records needed to verify transactions already sent are kept. It does not stop a runtime that is still running; stop it where it runs.</p>
    {confirm ? <div className="agents-actions"><button className="button button-dark" disabled={busy} onClick={() => act(async () => { await runtimeAdmin.archive(id); navigate('/agents'); })}>Confirm archive</button><button className="button button-outline" onClick={() => setConfirm(false)}>Keep</button></div>
      : <button className="button button-outline" disabled={busy} onClick={() => setConfirm(true)}>Archive agent</button>}
  </section>;
}

function setupSteps(profile: ProfileJSON, rt: any): Step[] {
  const credential = (rt.credentials ?? []).some((c: any) => c.status === 'active');
  const reported = (rt.heartbeats ?? []).length > 0, decided = (rt.decisions ?? []).length > 0, live = !!rt.policy?.liveEnabled;
  const order = [!!profile.wallet, credential, reported, decided];
  const first = order.indexOf(false);
  const state = (i: number, done: boolean): Step['state'] => (done ? 'done' : i === first ? 'current' : 'upcoming');
  return [
    { key: 'wallet', title: 'Associate a dedicated wallet', state: state(0, order[0]) },
    { key: 'credential', title: 'Issue a credential', meta: 'Shown once. Store it where the agent runs.', state: state(1, order[1]) },
    { key: 'run', title: 'Run it in paper mode', meta: 'Paper mode records decisions without sending trades.', state: state(2, order[2]) },
    { key: 'review', title: 'Review its decisions', state: state(3, order[3]) },
    { key: 'live', title: 'Allow live testnet trades (optional)', meta: 'In Settings, after reviewing paper decisions.', state: live ? 'done' : first === -1 ? 'current' : 'upcoming' },
  ];
}
