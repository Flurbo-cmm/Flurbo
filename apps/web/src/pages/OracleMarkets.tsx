import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { ArrowLeft, ArrowUpRight, RefreshCw } from 'lucide-react';
import { formatEther, formatUnits } from 'viem';
import { appFetch } from '../platform-fetch';
import { useAuth } from '../auth/context';
import { discoverWallets, type BrowserWallet } from '../auth/wallet-choice';
import { watchTradingWallet, type TradingConnection } from '../auth/trading-session';
import { linkedWallets, linkTradingWallet } from '../wallet-links';
import { type OracleMarket, type OracleMarketSummary } from '../market-directory';
import SegmentedControl from '../components/ui/SegmentedControl';
import QuantityStepper from '../components/ui/QuantityStepper';
import StatusBadge, { type StatusKind } from '../components/ui/StatusBadge';
import Stepper, { type Step } from '../components/ui/Stepper';
import PriceHistory from './PriceHistory';
import './market-detail.css';
import './pilot.css';
import './oracle.css';

const arbitration = { disputed: 1, ruled: 2 } as const;

type OracleUser = { wallet: string; creditedEthWei: string; noShares: string; yesShares: string;
  cashAtoms: string; allowanceAtoms: string };
type OracleSnapshot = OracleMarket & { schema: string; reality: string; arbitrator: string;
  questionId: string; questionTxHash: string; resolver: string; relay: string; historyHash: string;
  answer: string | null; answerLabel: string | null;
  bondWei: string; minBondWei: string; nextBondWei: string; disputeFeeWei: string;
  opensAt: number; finalizesAt: number; sourceNow: number; marketNow: number;
  finalized: boolean; pendingArbitration: boolean; dispute: null | { status: number; disputeId: string; ruling: string };
  reportDeadline: number; phase: number; reported: number; funded: boolean; resolved: boolean;
  user: OracleUser | null };
type OraclePlan = { action: string; reason: string; amountWei?: string; amountAtoms?: string;
  transaction: { chainId: number; from: string; to: string; data: string; value: string } };
type Pending = { hash: string; chainId: number; action: string; owner: string; market: string };
type TradeQuote = { action: 'quote'; buyAtoms: string; maxCostAtoms: string; sellAtoms: string | null;
  allowanceAtoms: string; cashAtoms: string; holdingsAtoms: string };

const pendingKey = 'flurbo.oracle.pending.v1';
const savedPending = (): Pending | null => {
  try {
    const value = JSON.parse(sessionStorage.getItem(pendingKey) || 'null');
    return /^0x[0-9a-f]{64}$/i.test(value?.hash) && [11155111, 10143].includes(value?.chainId) ? value : null;
  } catch { return null; }
};
const date = (seconds: number) => new Date(seconds * 1000).toLocaleString(undefined,
  { dateStyle: 'medium', timeStyle: 'short' });
const eth = (wei: string) => formatEther(BigInt(wei));
const ausd = (atoms: string) => formatUnits(BigInt(atoms), 6);
const zero = (value: string) => !value || BigInt(value) === 0n;
const chainName = (id: number) => id === 11155111 ? 'Sepolia' : 'Monad testnet';
const friendly = (error: unknown) => {
  const value = error as { code?: number; message?: string };
  return value?.code === 4001 ? 'Transaction cancelled in MetaMask.'
    : value?.message && value.message.length < 220 ? value.message
      : 'This request could not be completed. Refresh its on-chain status and try again.';
};
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await appFetch(path, { method, credentials: 'same-origin',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000) });
  const value = await response.json();
  if (!response.ok) throw Error(value.error || 'Oracle request failed');
  return value as T;
}

async function selectChain(provider: BrowserWallet['provider'], chainId: number) {
  const hex = `0x${chainId.toString(16)}`;
  if (await provider.request({ method: 'eth_chainId' }) === hex) return;
  try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] }); }
  catch (error) {
    if ((error as { code?: number })?.code !== 4902) throw error;
    await provider.request({ method: 'wallet_addEthereumChain', params: [chainId === 11155111
      ? { chainId: hex, chainName: 'Sepolia', nativeCurrency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 },
        rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'], blockExplorerUrls: ['https://sepolia.etherscan.io'] }
      : { chainId: hex, chainName: 'Monad Testnet', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
        rpcUrls: ['https://testnet-rpc.monad.xyz'], blockExplorerUrls: ['https://testnet.monadscan.com'] }] });
  }
  if (await provider.request({ method: 'eth_chainId' }) !== hex) throw Error(`Switch MetaMask to ${chainName(chainId)}.`);
}

export default function OracleMarketDetail({ id, markets }: { id: string; markets: OracleMarket[] }) {
  const { state: auth } = useAuth();
  const [snapshot, setSnapshot] = useState<OracleSnapshot | null>(null);
  const [summary, setSummary] = useState<OracleMarketSummary | null>(null);
  const [wallets, setWallets] = useState<BrowserWallet[]>([]);
  const [walletChoice, setWalletChoice] = useState(0);
  const [provider, setProvider] = useState<BrowserWallet['provider'] | null>(null);
  const [owner, setOwner] = useState('');
  const [walletStatus, setWalletStatus] = useState<TradingConnection['status']>('checking');
  const activeOwner = useRef('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<OraclePlan | null>(null);
  const [pending, setPending] = useState<Pending | null>(savedPending);
  const [refresh, setRefresh] = useState(0);
  const [side, setSide] = useState<'yes' | 'no'>(() => new URLSearchParams(window.location.search).get('answer') === 'no' ? 'no' : 'yes');
  const [shares, setShares] = useState('1');
  const [tradeMode, setTradeMode] = useState<'buy' | 'sell'>('buy');
  const [quote, setQuote] = useState<TradeQuote | null>(null);
  const [extra1, setExtra1] = useState('');
  const [extra2, setExtra2] = useState('');
  const [extra1Side, setExtra1Side] = useState<'yes' | 'no'>('yes');
  const [extra2Side, setExtra2Side] = useState<'yes' | 'no'>('yes');
  const [position, setPosition] = useState<string | null>(null);
  const [answer, setAnswer] = useState<'yes' | 'no' | 'void'>('yes');
  const [bondEth, setBondEth] = useState('');
  const [ruling, setRuling] = useState(2);
  const [appealEth, setAppealEth] = useState('0.001');
  const [evidence, setEvidence] = useState({ name: '', description: '', sourceURL: '' });
  const [evidenceHash, setEvidenceHash] = useState('');
  const generation = useRef(0);

  useEffect(() => discoverWallets(wallet => setWallets(current => current.some(item => item.provider === wallet.provider)
    ? current : [...current, wallet])), []);
  useEffect(() => {
    const selected = wallets[walletChoice]?.provider;
    if (!selected || !auth.address) {
      activeOwner.current = '';
      setOwner(''); setProvider(null); setWalletStatus('disconnected');
      return;
    }
    return watchTradingWallet({ provider: selected, account: auth.address, links: linkedWallets,
      publish: value => {
        setWalletStatus(value.status);
        if (activeOwner.current !== value.owner) {
          activeOwner.current = value.owner;
          setPlan(null); setQuote(null);
        }
        setOwner(value.owner);
        setProvider(value.owner ? selected : null);
      } });
  }, [wallets[walletChoice]?.provider, auth.address]);
  useEffect(() => {
    if (!markets.some(m => m.id === id)) return;
    const current = ++generation.current;
    setError('');
    void request<OracleSnapshot>(`/api/oracle/${id}${owner ? `?wallet=${owner}` : ''}`)
      .then(value => { if (generation.current === current) setSnapshot(value); })
      .catch(e => { if (generation.current === current) setError(friendly(e)); });
    return () => { generation.current++; };
  }, [id, markets, owner, refresh]);
  useEffect(() => {
    const selected = markets.find(m => m.id === id);
    if (!selected) return;
    let live = true;
    setSummary(null);
    void request<OracleMarketSummary>(`/api/oracle/${id}/market`)
      .then(value => {
        if (live && value.schema === 'flurbo.oracle-market.v1' && value.id === id
          && value.pool.toLowerCase() === selected.pool.toLowerCase()) setSummary(value);
      }).catch(() => {});
    return () => { live = false; };
  }, [id, markets, refresh]);
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden && !busy) setRefresh(n => n + 1); }, 30_000);
    return () => clearInterval(timer);
  }, [busy]);
  useEffect(() => {
    if (!snapshot) return;
    setBondEth(eth(snapshot.nextBondWei));
  }, [snapshot?.questionId, snapshot?.nextBondWei]);

  async function connect(wallet = wallets[walletChoice]) {
    if (!wallet) throw Error('Install MetaMask or open Flurbo in its browser.');
    if (!auth.address) throw Error('Sign in first.');
    setBusy(true); setError(''); setOwner(''); setProvider(null); setPlan(null);
    try {
      if (owner) await wallet.provider.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
      const accounts = await wallet.provider.request({ method: 'eth_requestAccounts' }) as string[];
      if (!Array.isArray(accounts) || !/^0x[0-9a-f]{40}$/i.test(accounts[0] || '')) throw Error('Select a MetaMask account.');
      setNotice('Confirm the account link in MetaMask if requested.');
      await linkTradingWallet(wallet.provider, auth.address, accounts[0]);
      activeOwner.current = accounts[0].toLowerCase();
      setProvider(wallet.provider); setOwner(accounts[0]);
      setWalletStatus('connected');
      setNotice('MetaMask connected. This wallet signs each transaction you review.');
    } finally { setBusy(false); }
  }
  async function prepare(action: string, input: Record<string, unknown> = {}) {
    if (!id || !owner) throw Error('Connect MetaMask first.');
    if (pending) throw Error('Check your pending transaction before preparing another.');
    setBusy(true); setError(''); setPlan(null);
    try {
      const value = await request<OraclePlan>(`/api/oracle/${id}/action`, 'POST', { action, input, owner });
      setPlan(value); setNotice('Review the destination, network and amount before confirming in MetaMask.');
    } finally { setBusy(false); }
  }
  async function storeEvidence() {
    if (!id) return;
    setBusy(true); setError('');
    try {
      const value = await request<{ hash: string; uri: string }>(`/api/oracle/${id}/evidence`, 'POST', evidence);
      setEvidenceHash(value.hash);
      setNotice('Public evidence saved. Review the on-chain submission next.');
    } finally { setBusy(false); }
  }
  async function confirm() {
    if (!plan || !provider || !owner || !id) throw Error('Connect MetaMask and review a transaction first.');
    setBusy(true); setError('');
    try {
      const tx = plan.transaction;
      await selectChain(provider, tx.chainId);
      const accounts = await provider.request({ method: 'eth_accounts' }) as string[];
      if (!Array.isArray(accounts) || accounts[0]?.toLowerCase() !== owner.toLowerCase()
        || tx.from.toLowerCase() !== owner.toLowerCase()) throw Error('MetaMask account changed. Reconnect and review again.');
      const hash = await provider.request({ method: 'eth_sendTransaction', params: [{
        from: tx.from, to: tx.to, data: tx.data, value: tx.value, chainId: `0x${tx.chainId.toString(16)}`,
      }] }) as string;
      if (!/^0x[0-9a-f]{64}$/i.test(hash)) throw Error('MetaMask did not return a transaction hash. Check wallet activity.');
      const next = { hash, chainId: tx.chainId, action: plan.action, owner, market: id };
      sessionStorage.setItem(pendingKey, JSON.stringify(next));
      setPending(next); setPlan(null);
      setNotice('Transaction submitted. Check its status here before taking another action.');
    } finally { setBusy(false); }
  }
  async function checkPending() {
    if (!pending || !provider) throw Error('Reconnect MetaMask to check this transaction.');
    setBusy(true); setError('');
    try {
      await selectChain(provider, pending.chainId);
      const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [pending.hash] }) as { status?: string } | null;
      if (!receipt) { setNotice('Still pending. Check again shortly.'); return; }
      sessionStorage.removeItem(pendingKey); setPending(null);
      setNotice(receipt.status === '0x1' ? 'Transaction confirmed on-chain.' : 'Transaction failed on-chain. Review the latest status.');
      setRefresh(n => n + 1);
    } finally { setBusy(false); }
  }
  const run = (task: () => Promise<void>) => void task().catch(e => setError(friendly(e)));
  const market = markets.find(m => m.id === id);
  const others = markets.filter(m => m.pool.toLowerCase() === market?.pool.toLowerCase() && m.id !== id);
  const claim = market ? [{ eventIndex: market.eventIndex, side },
    ...(extra1 ? [{ eventIndex: others.find(m => m.id === extra1)?.eventIndex ?? -1, side: extra1Side }] : []),
    ...(extra2 ? [{ eventIndex: others.find(m => m.id === extra2)?.eventIndex ?? -1, side: extra2Side }] : [])] : [];
  useEffect(() => { setExtra1(''); setExtra2(''); setPosition(null); }, [id]);
  useEffect(() => {
    if (!id || !owner || !market) { setPosition(null); return; }
    let live = true;
    void request<{ holdingsAtoms: string }>(`/api/oracle/${id}/action`, 'POST', {
      action: 'position', input: { side, claim }, owner,
    }).then(value => { if (live) setPosition(typeof value.holdingsAtoms === 'string' && /^\d+$/.test(value.holdingsAtoms) ? value.holdingsAtoms : null); })
      .catch(() => { if (live) setPosition(null); });
    return () => { live = false; };
  }, [id, owner, market, side, extra1, extra2, extra1Side, extra2Side, refresh]);
  useEffect(() => {
    if (!id || !owner || !market || !snapshot || snapshot.marketNow >= snapshot.closesAt || snapshot.resolved
      || !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(shares) || Number(shares) <= 0) { setQuote(null); return; }
    let live = true;
    setQuote(null);
    const timer = setTimeout(() => {
      void request<TradeQuote>(`/api/oracle/${id}/action`, 'POST', {
        action: 'quote', input: { side, quantity: shares, claim }, owner,
      }).then(value => { if (live && value.action === 'quote') setQuote(value); }).catch(() => {});
    }, 300);
    return () => { live = false; clearTimeout(timer); };
  }, [id, owner, market, snapshot?.marketNow, snapshot?.resolved, side, shares, extra1, extra2, extra1Side, extra2Side, refresh]);
  const activePending = pending?.market === id ? pending : null;
  const canAnswer = snapshot && !snapshot.finalized && !snapshot.pendingArbitration && snapshot.sourceNow >= snapshot.opensAt
    && (zero(snapshot.bondWei) || snapshot.sourceNow < snapshot.finalizesAt);
  const canArbitrate = snapshot && !snapshot.finalized && !snapshot.pendingArbitration && !zero(snapshot.bondWei)
    && snapshot.sourceNow < snapshot.finalizesAt;
  const hasAnswer = snapshot && !zero(snapshot.bondWei);
  const closed = snapshot ? snapshot.marketNow >= snapshot.closesAt : market ? Date.now() / 1000 >= market.closesAt : false;
  const statusKind: StatusKind = snapshot?.resolved ? 'collect' : snapshot?.pendingArbitration ? 'disputed'
    : canArbitrate ? 'challenge' : snapshot?.finalized || snapshot?.phase === 1 || canAnswer ? 'waiting'
      : closed ? 'closed' : 'open';
  const statusLabel = snapshot?.resolved ? 'Ready to collect' : snapshot?.pendingArbitration ? 'Kleros review'
    : canArbitrate ? 'Answer open for challenge' : snapshot?.finalized ? 'Final answer, awaiting relay'
      : snapshot?.phase === 1 ? 'Result received, preparing payouts'
        : canAnswer && !hasAnswer ? 'Awaiting bonded answer' : closed ? 'Trading closed' : 'Open for predictions';
  const stage = snapshot?.resolved ? 6 : snapshot?.phase === 1 ? 5 : snapshot?.finalized ? 5
    : snapshot?.pendingArbitration ? 4 : hasAnswer ? 3 : snapshot && snapshot.sourceNow >= snapshot.opensAt ? 2 : closed ? 1 : 0;
  const step = (key: string, title: string, meta: string, index: number): Step => ({ key, title, meta,
    state: index < stage ? 'done' : index === stage ? 'current' : 'upcoming' });
  const steps: Step[] = [
    step('trading', 'Trading', `Closes ${market ? date(market.closesAt) : ''}`, 0),
    step('observed', 'Source window', `Opens ${market ? date(market.observationEndsAt) : ''}`, 1),
    step('answer', hasAnswer ? 'Answer proposed' : 'Awaiting bonded answer',
      hasAnswer ? 'A bonded answer was posted on Reality.eth' : 'Waiting for the first bonded answer on Reality.eth', 2),
    step('challenge', 'Challenge window', 'Another answer or a Kleros challenge can be submitted', 3),
    ...(snapshot?.pendingArbitration || snapshot?.dispute ? [step('review', 'Kleros review', 'Jurors review public evidence and may hear an appeal', 4)] : []),
    step('final', 'Final answer', 'Reality.eth finalizes the answer, then the relay reports it to Monad', 5),
    step('payout', 'Payouts', 'Available once every question in the shared pool is resolved', 6),
  ];
  const selectedHoldings = position === null ? null : ausd(position);
  const needsApproval = quote && BigInt(quote.allowanceAtoms) < BigInt(quote.maxCostAtoms);
  const canTrade = !!owner && !busy && !pending && !closed && !snapshot?.resolved && !!quote;

  return <main id="main" tabIndex={-1} className="page markets-page market-detail oracle-page">
    <nav className="detail-breadcrumb" aria-label="Breadcrumb"><Link href="/markets" className="link-back"><ArrowLeft size={18}/>All markets</Link><Link href="/fund" className="text-link">Get test funds</Link></nav>
    {error && !market && <p className="state-inline error" role="alert">{error}</p>}
    {!market && <div className="state-block"><h1>Market not found</h1><Link href="/markets" className="btn btn-secondary">All markets</Link></div>}
    {market && <>
      <header className="detail-heading"><span className="chip">Real event</span><h1>{market.question}</h1>
        <dl className="detail-meta"><div><dt>Status</dt><dd><StatusBadge kind={statusKind}>{statusLabel}</StatusBadge></dd></div>
          <div><dt>Trading closes</dt><dd><time dateTime={new Date(market.closesAt * 1000).toISOString()}>{date(market.closesAt)}</time></dd></div>
          <div><dt>Results expected from</dt><dd><time dateTime={new Date(market.observationEndsAt * 1000).toISOString()}>{date(market.observationEndsAt)}</time></dd></div>
          {summary && !closed && <div><dt>Buy one share</dt><dd>Yes {summary.prices.yes === null ? 'unavailable' : Number(ausd(summary.prices.yes)).toFixed(3)} · No {summary.prices.no === null ? 'unavailable' : Number(ausd(summary.prices.no)).toFixed(3)}<small>test AUSD, not probabilities</small></dd></div>}</dl></header>
      <div className="detail-columns"><div className="detail-primary">
        {error && <p className="state-inline error" role="alert">{error}</p>}
        {notice && <p className="state-inline" role="status">{notice}</p>}
        {!snapshot && !error && <p role="status">Reading both testnets...</p>}
        <PriceHistory oracleId={id} event={0} pool={market.pool} refresh={refresh}/>
        {snapshot && <>
          {others.length > 0 && <details className="detail-panel detail-connect"><summary>Explore how these markets connect</summary><p className="market-caption">These questions share one pool. Select up to two more outcomes in the prediction ticket to trade a combination. Every selected answer must be correct.</p><ul>{others.map(other => <li key={other.id}><Link href={`/markets/oracle/${other.id}`} className="text-link">{other.question}</Link></li>)}</ul></details>}
          <section className="detail-panel detail-settlement" aria-label="Settlement timeline"><div className="panel-head"><h2>From prediction to payout</h2><StatusBadge kind={statusKind}>{statusLabel}</StatusBadge></div>
            <p>Your shares stay in your wallet while the event runs. Reality.eth accepts bonded answers, Kleros hears disputes, and Flurbo relays final answers to Monad.</p><Stepper steps={steps} label="Settlement steps"/>
            {(hasAnswer || snapshot.phase === 1) && <div className="detail-challenge"><p>Proposed answer: <strong>{snapshot.answerLabel || 'Awaiting Reality.eth'}</strong></p>{snapshot.finalizesAt > 0 && !snapshot.finalized && <p className="market-caption">Current answer may finalize {date(snapshot.finalizesAt)}. A new answer resets the countdown.</p>}</div>}
            <details className="disclosure"><summary>Settlement details</summary><dl className="oracle-facts"><div><dt>Reality.eth</dt><dd>{snapshot.finalized ? 'Final' : snapshot.pendingArbitration ? 'Kleros review' : hasAnswer ? 'Bonded answer open' : 'Waiting for an answer'}</dd></div>
              {hasAnswer && <div><dt>Highest answer bond</dt><dd>{eth(snapshot.bondWei)} Sepolia ETH</dd></div>}
              <div><dt>Monad result</dt><dd>{snapshot.phase === 1 ? ['Unset', 'No', 'Yes', 'Void'][snapshot.reported] : snapshot.resolved ? 'Resolved' : 'Awaiting final answer'}</dd></div></dl>
              <p className="market-caption">A dedicated relay reports the final Sepolia answer to this Monad testnet pool. The relay can misreport until verified cross-chain delivery is added.</p></details>
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setRefresh(n => n + 1)}><RefreshCw size={15}/>Refresh status</button>
            {snapshot.dispute && <p className="market-caption">Kleros case #{snapshot.dispute.disputeId}: {['none', 'requested', 'created', 'ruled', 'relayed'][snapshot.dispute.status] || 'status updating'}.</p>}

          {canAnswer && !hasAnswer && <div className="oracle-settlement-action"><h3>Submit an answer</h3><p>Anyone can propose the first answer with a Sepolia ETH bond. Connect a wallet, review the answer, then sign the Reality.eth transaction in MetaMask.</p>
            <div className="oracle-fields"><label>Answer<select value={answer} onChange={e => setAnswer(e.target.value as typeof answer)}><option value="yes">Yes</option><option value="no">No</option><option value="void">Void or invalid</option></select></label>
              <label>Bond in Sepolia ETH<input inputMode="decimal" value={bondEth} onChange={e => setBondEth(e.target.value)} /></label></div>
            <p className="market-caption">Minimum right now: {eth(snapshot.nextBondWei)} ETH. If another answer arrives first, the transaction may revert instead of paying a stale bond.</p>
            <button className="btn btn-primary" disabled={!canAnswer || !owner || busy || !!pending} onClick={() => run(() => prepare('answer', { answer, bondEth }))}>Review answer and bond</button>
          </div>}

          {canArbitrate && <div className="oracle-settlement-action"><h3>Challenge this answer</h3><p>Challenge the current Reality.eth answer through Kleros. The arbitration fee is {eth(snapshot.disputeFeeWei)} Sepolia ETH. Review it before MetaMask asks you to sign.</p>
            <button className="btn btn-primary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('arbitrate'))}>Review Kleros challenge fee</button>
            <details className="oracle-counteranswer"><summary>Post a different bonded answer instead</summary><p>Reality.eth also allows a counteranswer with a larger bond while the answer window is open. This does not start Kleros arbitration.</p>
              <div className="oracle-fields"><label>Counteranswer<select value={answer} onChange={e => setAnswer(e.target.value as typeof answer)}><option value="yes">Yes</option><option value="no">No</option><option value="void">Void or invalid</option></select></label>
                <label>Bond in Sepolia ETH<input inputMode="decimal" value={bondEth} onChange={e => setBondEth(e.target.value)} /></label></div>
              <p className="market-caption">Minimum right now: {eth(snapshot.nextBondWei)} ETH.</p>
              <button className="btn btn-secondary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('answer', { answer, bondEth }))}>Review counteranswer bond</button>
            </details>
          </div>}

          {snapshot.dispute?.status === arbitration.ruled && snapshot.pendingArbitration && <div className="oracle-settlement-action"><h3>Complete Kleros ruling</h3><p>Kleros has ruled. Flurbo verifies Reality's answer history, then prepares the transaction that sends the ruling into Reality so the question can finalize.</p><button className="btn btn-primary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('finalizeArbitration'))}>Review ruling report</button></div>}

          {snapshot.dispute && snapshot.dispute.status >= arbitration.ruled && <div className="oracle-settlement-action"><h3>Claim appeal rewards</h3><p>If you funded an appeal, select the ruling you supported. Flurbo checks whether this wallet can withdraw its contribution or reward.</p><label>Ruling funded<select value={ruling} onChange={e => setRuling(Number(e.target.value))}><option value={2}>Yes</option><option value={1}>No</option><option value={0}>Refuse to rule / invalid</option></select></label><button className="btn btn-secondary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('claimAppeal', { ruling }))}>Check and claim selected ruling</button></div>}

          {snapshot.finalized && !zero(snapshot.historyHash) && <div className="oracle-settlement-action"><h3>Claim answer bonds</h3><p>If this wallet posted a Reality answer, Flurbo prepares the history transaction that credits eligible answerers. You can withdraw credited ETH from your wallet panel.</p><button className="btn btn-secondary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('claimWinnings'))}>Review bond claim</button></div>}

          {snapshot.pendingArbitration && snapshot.dispute && snapshot.dispute.status === arbitration.disputed && <div className="oracle-settlement-action"><h3>Submit evidence</h3><p>Evidence is public and identified by its content hash. Include only information you may disclose to jurors and everyone else.</p>
            <div className="oracle-fields"><label>Title<input maxLength={120} value={evidence.name} onChange={e => setEvidence(v => ({ ...v, name: e.target.value }))}/></label>
              <label>Public source URL<input type="url" value={evidence.sourceURL} onChange={e => setEvidence(v => ({ ...v, sourceURL: e.target.value }))}/></label>
              <label className="oracle-wide">Explanation<textarea rows={5} maxLength={8000} value={evidence.description} onChange={e => setEvidence(v => ({ ...v, description: e.target.value }))}/></label></div>
            <div className="cluster"><button className="btn btn-secondary" disabled={!owner || busy || !!pending} onClick={() => run(storeEvidence)}>Save public evidence</button>
              {evidenceHash && <button className="btn btn-primary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('evidence', { hash: evidenceHash }))}>Review on-chain evidence submission</button>}</div>
          </div>}

          {snapshot.dispute?.status === arbitration.disputed && <div className="oracle-settlement-action"><h3>Fund an appeal</h3><p>Kleros appeal contributions use Sepolia ETH. Enter the amount you want to contribute. Flurbo simulates the transaction against the pinned proxy before MetaMask asks you to sign.</p>
            <div className="oracle-fields"><label>Contribution in Sepolia ETH<input inputMode="decimal" value={appealEth} onChange={e => setAppealEth(e.target.value)}/></label><label>Ruling to support<select value={ruling} onChange={e => setRuling(Number(e.target.value))}><option value={2}>Yes</option><option value={1}>No</option><option value={0}>Refuse to rule / invalid</option></select></label></div>
            <button className="btn btn-secondary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('appeal', { ruling, amountEth: appealEth }))}>Review appeal contribution</button></div>}
          {plan?.transaction.chainId === 11155111 && <div className="ticket-review" aria-label="Transaction review"><h3>Review on Sepolia</h3><p>{plan.reason}</p><p className="market-caption">Destination: <span className="mono oracle-address">{plan.transaction.to}</span></p><p className="market-caption">Sepolia ETH: {eth(BigInt(plan.transaction.value).toString())}</p><div className="cluster"><button className="btn btn-primary" disabled={busy} onClick={() => run(confirm)}>Confirm in MetaMask</button><button className="btn btn-secondary" disabled={busy} onClick={() => setPlan(null)}>Cancel review</button></div></div>}
          {activePending?.chainId === 11155111 && <div className="oracle-settlement-action"><h3>Transaction pending</h3><p className="mono oracle-address">{activePending.hash}</p><button className="btn btn-secondary" disabled={!provider || busy} onClick={() => run(checkPending)}>Check status</button></div>}
          </section>
          <section className="detail-panel"><h2>What decides the answer?</h2><p>The published Reality.eth question sets the rule. Anyone can read the Sepolia question and its answer history.</p><a className="text-link" href={`https://sepolia.etherscan.io/tx/${snapshot.questionTxHash}`} target="_blank" rel="noreferrer">View source question <ArrowUpRight aria-hidden="true" strokeWidth={1.75}/></a><div className="settlement-source"><h3>What settlement reads</h3><p>Reality.eth records bonded answers for this question. A Kleros ruling settles a dispute. Flurbo relays the final answer to the Monad pool.</p><p className="mono oracle-address">Question ID: {snapshot.questionId}</p></div><details className="disclosure"><summary>Read the resolution rules</summary><p>{market.question}</p><p>Unclear or unavailable outcomes can resolve as Void under this question's published rule.</p></details></section>
          <details className="detail-panel"><summary>Shared pool details</summary><p className="market-caption">Payouts open when every question in this pool is final or void.</p><dl className="oracle-facts"><div><dt>Settlement</dt><dd>Reality.eth and Kleros on Sepolia</dd></div><div><dt>Delivery</dt><dd>Dedicated testnet relay</dd></div></dl><a className="text-link" href={`https://testnet.monadscan.com/address/${snapshot.pool}`} target="_blank" rel="noreferrer">View pool <ArrowUpRight aria-hidden="true" strokeWidth={1.75}/></a></details>
        </>}
      </div><aside className="detail-sidebar" aria-label="Trade and position">
        {snapshot && <section className="detail-panel detail-trade" aria-label="Trade this market">
          {!snapshot.resolved && !closed && summary && <div className="detail-holdings detail-quotes"><div><span>Yes</span><strong>{summary.prices.yes === null ? 'Unavailable' : `${ausd(summary.prices.yes)} AUSD`}</strong></div><div><span>No</span><strong>{summary.prices.no === null ? 'Unavailable' : `${ausd(summary.prices.no)} AUSD`}</strong></div><p className="market-caption">Price per share, test AUSD. Exact quote before you confirm.</p></div>}
          <div className="consumer-ticket"><div className="ticket-head"><h2>{snapshot.resolved ? 'Collect your prediction' : 'Your prediction'}</h2><p className="market-caption">Each winning share pays 1 test AUSD. Choose your answer and number of shares below.</p></div>
            <div className="ticket-wallet"><div><strong className="mono">{owner ? `${owner.slice(0, 6)}...${owner.slice(-4)}` : 'Connect a trading wallet'}</strong><small>{snapshot.user ? `${ausd(snapshot.user.cashAtoms)} test AUSD` : 'MetaMask signs Monad trades and Sepolia bonds'}</small></div><button className="btn btn-secondary btn-sm" disabled={busy || walletStatus === 'checking'} onClick={() => run(() => connect())}>{owner ? 'Switch wallet' : walletStatus === 'checking' ? 'Checking wallet...' : walletStatus === 'unlinked' ? 'Link selected wallet' : 'Connect MetaMask'}</button></div>
            {wallets.length > 1 && <label className="oracle-wallet-provider">Wallet provider<select aria-label="MetaMask provider" value={walletChoice} onChange={e => { activeOwner.current = ''; setWalletChoice(Number(e.target.value)); setProvider(null); setOwner(''); setPlan(null); }}>{wallets.map((w, i) => <option key={i} value={i}>{w.name} {i + 1}</option>)}</select></label>}
            <div className="ticket-controls">
              {!snapshot.resolved && !closed && <SegmentedControl label="Buy or sell" value={tradeMode} options={[{ value: 'buy', label: 'Buy' }, { value: 'sell', label: 'Sell' }]} onChange={value => { setTradeMode(value); setPlan(null); }} block/>}
              <SegmentedControl label="Your answer" value={side} options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} onChange={value => { setSide(value); setPlan(null); }} block/>
              <QuantityStepper label="Shares" value={shares} max={20} onChange={value => { setShares(value); setPlan(null); }}/>
              {others.length > 0 && <details className="oracle-combination"><summary>Combine with another prediction</summary><p className="market-caption">Every selected answer must be correct. Up to three questions from this pool can be combined.</p><div className="oracle-fields"><label>Second question<select value={extra1} onChange={e => { setExtra1(e.target.value); setExtra2(''); setPlan(null); }}><option value="">None</option>{others.map(m => <option key={m.id} value={m.id}>{m.question}</option>)}</select></label>
                {extra1 && <label>Second answer<select value={extra1Side} onChange={e => { setExtra1Side(e.target.value as 'yes' | 'no'); setPlan(null); }}><option value="yes">Yes</option><option value="no">No</option></select></label>}
                {extra1 && <label>Third question<select value={extra2} onChange={e => { setExtra2(e.target.value); setPlan(null); }}><option value="">None</option>{others.filter(m => m.id !== extra1).map(m => <option key={m.id} value={m.id}>{m.question}</option>)}</select></label>}
                {extra2 && <label>Third answer<select value={extra2Side} onChange={e => { setExtra2Side(e.target.value as 'yes' | 'no'); setPlan(null); }}><option value="yes">Yes</option><option value="no">No</option></select></label>}</div></details>}
            </div>
            {snapshot.resolved ? <p className="ticket-status">Final results are in. Review the payout for the selected shares.</p> : closed ? <p className="ticket-status">Trading has closed. Results will appear in the settlement timeline.</p>
              : !owner ? <p className="ticket-status">Connect MetaMask to see your exact quote and holdings.</p>
                : !quote ? <p className="ticket-status">Refreshing the pool price for your selection...</p>
                  : <p className="ticket-status">{tradeMode === 'buy' ? `Buy quote: ${ausd(quote.buyAtoms)} test AUSD. Maximum with price tolerance: ${ausd(quote.maxCostAtoms)}.` : quote.sellAtoms === null ? 'Not enough selected shares to sell.' : `Sell quote: ${ausd(quote.sellAtoms)} test AUSD, before price tolerance.`}</p>}
            {!snapshot.resolved && !closed && <button className="text-link ticket-refresh" disabled={busy} onClick={() => setRefresh(n => n + 1)}>Refresh price</button>}
            {snapshot.resolved ? <button className="btn btn-primary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('redeem', { side, quantity: shares, claim }))}>Review payout</button>
              : !closed && <button className="btn btn-primary oracle-ticket-action" disabled={!canTrade || (tradeMode === 'sell' && quote?.sellAtoms === null) || (tradeMode === 'buy' && !!quote && BigInt(quote.cashAtoms) < BigInt(quote.maxCostAtoms))} onClick={() => run(() => prepare(tradeMode === 'sell' ? 'sell' : needsApproval ? 'approve' : 'buy', { side, quantity: shares, claim }))}>{tradeMode === 'sell' ? 'Review sale' : needsApproval ? 'Allow payment' : 'Review purchase'}</button>}
            {quote && tradeMode === 'buy' && BigInt(quote.cashAtoms) < BigInt(quote.maxCostAtoms) && <p className="market-caption">This wallet needs more test AUSD. <Link href="/fund" className="text-link">Get test funds</Link></p>}
            {plan?.transaction.chainId === 10143 && <div className="ticket-review" aria-label="Transaction review"><h3>{plan.action === 'approve' ? 'Step 1 of 2: allow this payment' : plan.action === 'buy' ? 'Review your purchase' : plan.action === 'sell' ? 'Review your sale' : 'Review your payout'}</h3><p className="review-claim">{plan.reason}</p><dl className="review-figures"><div className="review-cost"><dt>{plan.action === 'approve' ? 'Spending allowance' : plan.action === 'sell' ? 'Expected proceeds' : plan.action === 'redeem' ? 'Expected payout' : 'Quoted cost'}</dt><dd>{plan.amountAtoms ? `${ausd(plan.amountAtoms)} test AUSD` : 'See wallet'}</dd></div><div><dt>Network</dt><dd>Monad testnet</dd></div><div><dt>Destination</dt><dd className="mono oracle-address">{plan.transaction.to}</dd></div></dl><p className="market-caption">Check the amount and destination. Approval alone does not buy shares.</p><button className="btn btn-primary" disabled={busy} onClick={() => run(confirm)}>{plan.action === 'approve' ? 'Allow payment in MetaMask' : 'Confirm in MetaMask'}</button><button className="btn btn-secondary" disabled={busy} onClick={() => setPlan(null)}>Cancel review</button></div>}
            {activePending?.chainId === 10143 && <div className="ticket-review ticket-pending"><h3>Transaction pending</h3><p className="mono oracle-address">{activePending.hash}</p><button className="btn btn-secondary" disabled={!provider || busy} onClick={() => run(checkPending)}>Check status</button></div>}
            <details className="disclosure"><summary>How this market works</summary><p>Trades use test AUSD on Monad. Reality.eth answers and Kleros disputes happen on Sepolia. Your trading wallet can sign both without leaving Flurbo.</p></details>
          </div></section>}
        <section className="detail-panel detail-position" aria-label="Your position"><div className="panel-head"><h2>Your position</h2><Link href="/portfolio" className="text-link">Other positions <ArrowUpRight aria-hidden="true" strokeWidth={1.75}/></Link></div><p className="market-caption">In your selected trading wallet</p>
          {snapshot?.user ? <dl className="position-rows"><div><dt>Yes</dt><dd><strong>{ausd(snapshot.user.yesShares)} shares</strong><small>{zero(snapshot.user.yesShares) ? 'No position' : snapshot.resolved ? 'Check payout' : 'Open position'}</small></dd></div><div><dt>No</dt><dd><strong>{ausd(snapshot.user.noShares)} shares</strong><small>{zero(snapshot.user.noShares) ? 'No position' : snapshot.resolved ? 'Check payout' : 'Open position'}</small></dd></div></dl> : <p className="market-caption">Connect your wallet to see your shares.</p>}
          {selectedHoldings !== null && claim.length > 1 && <p className="market-caption">Selected combination: {selectedHoldings} shares.</p>}
          {snapshot?.user && !zero(snapshot.user.creditedEthWei) && <div className="oracle-credit"><p className="market-caption">Reality.eth bond credit: {eth(snapshot.user.creditedEthWei)} Sepolia ETH</p><button className="btn btn-secondary" disabled={busy || !!pending} onClick={() => run(() => prepare('withdraw'))}>Review ETH withdrawal</button></div>}
          <p className="market-caption">Collect this pool's payouts here after every question resolves.</p></section>
        {pending && pending.market !== id && <p className="state-inline">A transaction for another oracle market is pending. Return there to check it.</p>}
      </aside></div>
    </>}
  </main>;
}

