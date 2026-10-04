import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { ArrowLeft, ArrowUpRight, RefreshCw } from 'lucide-react';
import { formatEther, formatUnits, parseUnits } from 'viem';
import { appFetch } from '../platform-fetch';
import { useAuth } from '../auth/context';
import { discoverWallets, type BrowserWallet } from '../auth/wallet-choice';
import { linkTradingWallet } from '../wallet-links';
import SegmentedControl from '../components/ui/SegmentedControl';
import QuantityStepper from '../components/ui/QuantityStepper';
import StatusBadge, { type StatusKind } from '../components/ui/StatusBadge';
import Stepper, { type Step } from '../components/ui/Stepper';
import PriceHistory from './PriceHistory';
import './market-detail.css';
import './pilot.css';
import './oracle.css';

type Market = { id: string; pool: string; poolTitle: string; eventIndex: number;
  question: string; route: 'mechanical' | 'reality'; closesAt: number; observationEndsAt: number };
type Snapshot = Market & { schema: string; resolver: string; eventHash: string; rulesHash: string;
  adapter: string; source: { publisher?: string; urls?: string[]; adapter?: string };
  marketNow: number; funded: boolean; resolved: boolean; delivered: boolean;
  assertionDeadline: number; reportDeadline: number; bondAtoms: string;
  phase: number; proposal: number; counter: number; result: number;
  challengeUntil: number; arbitrationUntil: number; requestId: string;
  sourceCaseId: string; proposalEvidenceURI: string | null;
  reality: null | { chainId: number; reality: string; arbitrator: string; questionId: string;
    sourceNow: number; opensAt: number; finalizesAt: number; bondWei: string;
    nextBondWei: string; disputeFeeWei: string; pendingArbitration: boolean;
    finalized: boolean; creditedEthWei: string; answerLabel: string | null;
    historyHash: string; disputeStatus: number; disputeId: string };
  user: null | { wallet: string; noShares: string; yesShares: string; cashAtoms: string;
    allowanceAtoms: string; bondAllowanceAtoms: string; bondCreditsAtoms: string } };
type Plan = { action: string; reason: string; transaction: { chainId: number; from: string;
  to: string; data: string; value: string } };
type Quote = { action: 'quote'; buyAtoms: string; maxCostAtoms: string;
  cashAtoms: string; allowanceAtoms: string; holdingsAtoms: string };
type PositionRead = { action: 'position'; holdingsAtoms: string; payoutAtoms: string | null };
type Pending = { hash: string; owner: string; id: string; action: string; chainId: number };

const date = (seconds: number) => new Date(seconds * 1000).toLocaleString(undefined,
  { dateStyle: 'medium', timeStyle: 'short' });
const cash = (atoms: string) => formatUnits(BigInt(atoms), 6);
const labels = ['Waiting', 'No', 'Yes', 'Void'];
const pendingKey = 'flurbo.hybrid.pending.v1';
const readPending = (): Pending | null => {
  try {
    const item = JSON.parse(sessionStorage.getItem(pendingKey) || 'null');
    return /^0x[0-9a-f]{64}$/i.test(item?.hash) && /^0x[0-9a-f]{40}$/i.test(item?.owner)
      && typeof item.id === 'string' && [10143,11155111].includes(item.chainId) ? item : null;
  } catch { return null; }
};
const friendly = (error: unknown) => {
  const value = error as { code?: number; message?: string };
  return value?.code === 4001 ? 'Transaction cancelled in MetaMask.'
    : value?.message && value.message.length < 220 ? value.message
      : 'This request could not be completed. Refresh and try again.';
};
async function request<T>(id: string, part = '', body?: unknown): Promise<T> {
  const response = await appFetch(`/api/hybrid/${id}${part}`, { method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin', cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000) });
  const value = await response.json();
  if (!response.ok) throw Error(value.error || 'Market request unavailable');
  return value as T;
}
async function selectChain(provider: BrowserWallet['provider'], id: number) {
  const chainId = `0x${id.toString(16)}`;
  if (await provider.request({ method: 'eth_chainId' }) === chainId) return;
  try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] }); }
  catch (error) {
    if ((error as { code?: number })?.code !== 4902) throw error;
    await provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId,
      chainName: id === 10143 ? 'Monad Testnet' : 'Sepolia',
      nativeCurrency: id === 10143 ? { name: 'MON', symbol: 'MON', decimals: 18 }
        : { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: [id === 10143 ? 'https://testnet-rpc.monad.xyz' : 'https://ethereum-sepolia-rpc.publicnode.com'],
      blockExplorerUrls: [id === 10143 ? 'https://testnet.monadscan.com' : 'https://sepolia.etherscan.io'] }] });
  }
  if (await provider.request({ method: 'eth_chainId' }) !== chainId)
    throw Error(`Switch MetaMask to ${id === 10143 ? 'Monad testnet' : 'Sepolia'}.`);
}

export default function HybridMarketDetail({ id, markets }: { id: string; markets: Market[] }) {
  const { state: auth } = useAuth();
  const market = markets.find(item => item.id.toLowerCase() === id.toLowerCase());
  const others = markets.filter(item => item.pool.toLowerCase() === market?.pool.toLowerCase() && item.id !== id);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [summary, setSummary] = useState<{ prices: { yes: string | null; no: string | null } } | null>(null);
  const [wallets, setWallets] = useState<BrowserWallet[]>([]);
  const [provider, setProvider] = useState<BrowserWallet['provider'] | null>(null);
  const [owner, setOwner] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [pending, setPending] = useState<Pending | null>(readPending);
  const [side, setSide] = useState<'yes' | 'no'>(() => new URLSearchParams(location.search).get('answer') === 'no' ? 'no' : 'yes');
  const [mode, setMode] = useState<'buy' | 'sell'>('buy');
  const [shares, setShares] = useState('1');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [combinedPosition, setCombinedPosition] = useState<PositionRead | null>(null);
  const [extra1, setExtra1] = useState('');
  const [extra2, setExtra2] = useState('');
  const [extra1Side, setExtra1Side] = useState<'yes' | 'no'>('yes');
  const [extra2Side, setExtra2Side] = useState<'yes' | 'no'>('yes');
  const [challenge, setChallenge] = useState({ name: '', description: '', sourceURL: '' });
  const [counter, setCounter] = useState(0);
  const [challengeEvidence, setChallengeEvidence] = useState<{ hash: string; uri: string } | null>(null);
  const [realityAnswer, setRealityAnswer] = useState<'yes'|'no'|'void'>('yes');
  const [bondEth, setBondEth] = useState('');
  const [appealRuling, setAppealRuling] = useState(1);
  const [appealEth, setAppealEth] = useState('');
  const run = (task: () => Promise<void>) => void task().catch(e => setError(friendly(e)));
  useEffect(() => discoverWallets(wallet => setWallets(current => current.some(item => item.provider === wallet.provider)
    ? current : [...current, wallet])), []);
  useEffect(() => {
    if (!market) return;
    let live = true;
    void request<Snapshot>(id, owner ? `?wallet=${owner}` : '').then(value => {
      if (live && value.pool.toLowerCase() === market.pool.toLowerCase()) setSnapshot(value);
    }).catch(e => { if (live) setError(friendly(e)); });
    void request<{ prices: { yes: string | null; no: string | null } }>(id, '/market')
      .then(value => { if (live) setSummary(value); }).catch(() => {});
    return () => { live = false; };
  }, [id, market, owner, refresh]);
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden && !busy) setRefresh(value => value + 1); }, 30_000);
    return () => clearInterval(timer);
  }, [busy]);
  useEffect(() => { setExtra1(''); setExtra2(''); setChallengeEvidence(null); }, [id]);
  useEffect(() => { if (snapshot?.reality) setBondEth(formatEther(BigInt(snapshot.reality.nextBondWei)));
  }, [snapshot?.reality?.nextBondWei, snapshot?.reality?.questionId]);
  const claim = market ? [{ eventIndex: market.eventIndex, side },
    ...(extra1 ? [{ eventIndex: others.find(item => item.id === extra1)?.eventIndex ?? -1, side: extra1Side }] : []),
    ...(extra2 ? [{ eventIndex: others.find(item => item.id === extra2)?.eventIndex ?? -1, side: extra2Side }] : [])] : [];
  useEffect(() => {
    if (!market || !owner || !snapshot || snapshot.marketNow >= market.closesAt || snapshot.resolved
      || !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(shares) || Number(shares) <= 0) {
      setQuote(null); return;
    }
    let live = true;
    const timer = setTimeout(() => {
      void request<Quote>(id, '/action', { action: 'quote', owner,
        input: { side, quantity: parseUnits(shares, 6).toString(), claim } })
        .then(value => { if (live) setQuote(value); }).catch(() => { if (live) setQuote(null); });
    }, 300);
    return () => { live = false; clearTimeout(timer); };
  }, [id, market, owner, snapshot?.marketNow, snapshot?.resolved, side, shares,
    extra1, extra2, extra1Side, extra2Side, refresh]);
  useEffect(() => {
    if (!market || !owner || !snapshot?.resolved || !extra1) {
      setCombinedPosition(null); return;
    }
    let live = true;
    setCombinedPosition(null);
    void request<PositionRead>(id, '/action', { action: 'position', owner, input: { side, claim } })
      .then(value => { if (live) setCombinedPosition(value); })
      .catch(e => { if (live) setError(friendly(e)); });
    return () => { live = false; };
  }, [id, market, owner, snapshot?.resolved, side, extra1, extra2,
    extra1Side, extra2Side, refresh]);

  async function connect(wallet = wallets.find(item => item.provider === provider) || wallets[0]) {
    if (!wallet || !auth.address) throw Error('Sign in and select MetaMask.');
    setBusy(true); setError(''); setPlan(null);
    try {
      if (owner) await wallet.provider.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
      const accounts = await wallet.provider.request({ method: 'eth_requestAccounts' }) as string[];
      if (!Array.isArray(accounts) || !/^0x[0-9a-f]{40}$/i.test(accounts[0] || ''))
        throw Error('Select a MetaMask account.');
      await linkTradingWallet(wallet.provider, auth.address, accounts[0]);
      setProvider(wallet.provider); setOwner(accounts[0]);
      setNotice('Wallet connected. Review each transaction before signing.');
    } finally { setBusy(false); }
  }
  async function prepare(action: string, input: Record<string, unknown> = {}) {
    if (!owner) throw Error('Connect MetaMask first.');
    if (pending) throw Error('Check the pending transaction first.');
    setBusy(true); setError(''); setPlan(null);
    try {
      const value = await request<Plan>(id, '/action', { action, owner, input });
      setPlan(value); setNotice('Review the destination and amount before signing in MetaMask.');
    } finally { setBusy(false); }
  }
  async function confirm() {
    if (!plan || !provider || !owner) throw Error('Connect MetaMask and review a transaction first.');
    setBusy(true); setError('');
    try {
      const transaction = plan.transaction;
      await selectChain(provider, transaction.chainId);
      const accounts = await provider.request({ method: 'eth_accounts' }) as string[];
      if (accounts[0]?.toLowerCase() !== owner.toLowerCase()
        || transaction.from.toLowerCase() !== owner.toLowerCase())
        throw Error('MetaMask account changed. Reconnect and review again.');
      const hash = await provider.request({ method: 'eth_sendTransaction', params: [{
        ...transaction, chainId: `0x${transaction.chainId.toString(16)}`,
      }] }) as string;
      if (!/^0x[0-9a-f]{64}$/i.test(hash)) throw Error('Check MetaMask activity before retrying.');
      const saved = { hash, owner, id, action: plan.action, chainId: transaction.chainId };
      sessionStorage.setItem(pendingKey, JSON.stringify(saved));
      setPending(saved); setPlan(null);
      setNotice('Transaction submitted. Check its result here before another action.');
    } finally { setBusy(false); }
  }
  async function checkPending() {
    if (!pending || !provider) throw Error('Reconnect MetaMask to check this transaction.');
    setBusy(true); setError('');
    try {
      await selectChain(provider, pending.chainId);
      const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [pending.hash] }) as { status?: string } | null;
      if (!receipt) { setNotice('Still pending. Check again shortly.'); return; }
      sessionStorage.removeItem(pendingKey); setPending(null); setPlan(null);
      setNotice(receipt.status === '0x1' ? 'Transaction confirmed.' : 'Transaction failed. Refresh the market before retrying.');
      setRefresh(value => value + 1);
    } finally { setBusy(false); }
  }
  async function saveChallengeEvidence() {
    setBusy(true); setError('');
    try {
      const saved = await request<{ hash: string; uri: string }>(id, '/evidence', challenge);
      setChallengeEvidence(saved);
      setNotice('Public evidence saved. Review the challenge transaction next.');
    } finally { setBusy(false); }
  }
  const closed = snapshot ? snapshot.marketNow >= snapshot.closesAt : !market || Date.now() / 1000 >= market.closesAt;
  const reality = snapshot?.reality;
  const hasRealityAnswer = reality ? BigInt(reality.bondWei) > 0n : false;
  const canAnswer = !!reality && !reality.finalized && !reality.pendingArbitration
    && reality.sourceNow >= reality.opensAt && (!hasRealityAnswer || reality.sourceNow < reality.finalizesAt);
  const canArbitrate = !!reality && hasRealityAnswer && !reality.finalized
    && !reality.pendingArbitration && reality.sourceNow < reality.finalizesAt;
  const status: StatusKind = snapshot?.resolved ? 'collect' : reality?.pendingArbitration ? 'disputed'
    : canArbitrate ? 'challenge' : snapshot?.phase === 2 ? 'disputed'
    : snapshot?.phase === 1 ? 'challenge' : closed ? 'closed' : 'open';
  const statusText = snapshot?.resolved ? 'Ready to collect' : reality?.pendingArbitration ? 'Kleros review'
    : canArbitrate ? 'Answer open for challenge' : reality?.finalized ? 'Final answer, awaiting relay'
    : reality && !hasRealityAnswer && reality.sourceNow >= reality.opensAt ? 'Awaiting bonded answer'
    : snapshot?.phase === 2 ? 'Kleros review'
    : snapshot?.phase === 1 ? 'Answer open for challenge' : snapshot?.phase === 3 ? 'Result final, awaiting pool'
      : closed ? 'Trading closed' : 'Open for predictions';
  const courtActive = !!reality?.pendingArbitration || snapshot?.phase === 2;
  const finalIndex = courtActive ? 5 : 4;
  const payoutIndex = courtActive ? 6 : 5;
  const stage = snapshot?.resolved ? payoutIndex : snapshot?.phase === 3 || reality?.finalized ? finalIndex
    : reality?.pendingArbitration ? 4 : canArbitrate ? 3 : reality && reality.sourceNow >= reality.opensAt ? 2
    : snapshot?.phase === 2 ? 4
    : snapshot?.phase === 1 ? 3 : snapshot && snapshot.marketNow >= snapshot.observationEndsAt ? 2 : closed ? 1 : 0;
  const step = (key: string, title: string, meta: string, index: number): Step => ({ key, title, meta,
    state: index < stage ? 'done' : index === stage ? 'current' : 'upcoming' });
  const steps: Step[] = reality ? [
    step('trading', 'Trading', market ? `Closes ${date(market.closesAt)}` : '', 0),
    step('source', 'Source opens', `Reality.eth opens ${date(reality.opensAt)}`, 1),
    step('proposal', hasRealityAnswer ? 'Answer proposed' : 'Awaiting bonded answer',
      hasRealityAnswer ? 'A bonded answer was posted on Reality.eth' : 'An answerer must post a Sepolia ETH bond', 2),
    step('challenge', 'Challenge window', 'Another answer or a Kleros challenge can be submitted', 3),
    ...(reality.pendingArbitration ? [step('court', 'Kleros review', 'Jurors review the disputed answer', 4)] : []),
    step('final', 'Final answer', 'Reality.eth finalizes, then the relay reports to Monad', finalIndex),
    step('payout', 'Payouts', 'Available when every question in this pool is final', payoutIndex),
  ] : [
    step('trading', 'Trading', market ? `Closes ${date(market.closesAt)}` : '', 0),
    step('source', 'Source observed', market ? `Window ends ${date(market.observationEndsAt)}` : '', 1),
    step('proposal', 'Answer proposed', 'The committed reader posts a bonded source result', 2),
    step('challenge', 'Challenge window', 'A different answer can be bonded in Flurbo', 3),
    ...(snapshot?.phase === 2 ? [step('court', 'Kleros review', 'Jurors review both evidence records', 4)] : []),
    step('final', 'Final answer', 'The result is final after the window or Kleros ruling', finalIndex),
    step('payout', 'Payouts', 'Available when every question in this pool is final', payoutIndex),
  ];
  const needsApproval = quote && BigInt(quote.allowanceAtoms) < BigInt(quote.maxCostAtoms);
  return <main id="main" tabIndex={-1} className="page markets-page market-detail oracle-page">
    <nav className="detail-breadcrumb" aria-label="Breadcrumb"><Link href="/markets" className="link-back"><ArrowLeft size={18}/>All markets</Link><Link href="/fund" className="text-link">Get test funds</Link></nav>
    {!market ? <div className="state-block"><h1>Market not found</h1><Link href="/markets" className="btn btn-primary">All markets</Link></div> : <>
      <header className="detail-heading"><span className="chip">Real event</span><h1>{market.question}</h1>
        <dl className="detail-meta"><div><dt>Status</dt><dd><StatusBadge kind={status}>{statusText}</StatusBadge></dd></div>
          <div><dt>Trading closes</dt><dd>{date(market.closesAt)}</dd></div>
          <div><dt>Results expected from</dt><dd>{date(market.observationEndsAt)}</dd></div>
          {summary && !closed && <div><dt>Buy one share</dt><dd>Yes {summary.prices.yes ? Number(cash(summary.prices.yes)).toFixed(3) : 'unavailable'} · No {summary.prices.no ? Number(cash(summary.prices.no)).toFixed(3) : 'unavailable'}<small>test AUSD, not probabilities</small></dd></div>}</dl>
      </header>
      <div className="detail-columns"><div className="detail-primary">
        {error && <p className="state-inline error" role="alert">{error}</p>}
        {notice && <p className="state-inline" role="status">{notice}</p>}
        {!snapshot && !error && <p role="status">Reading this market...</p>}
        <PriceHistory hybridId={id} event={0} pool={market.pool} refresh={refresh}/>
        {others.length > 0 && <details className="detail-panel detail-connect"><summary>Explore how these markets connect</summary><p className="market-caption">Questions in this pool can be combined in the prediction ticket.</p><ul>{others.map(other => <li key={other.id}><Link href={`/markets/hybrid/${other.id.replace(/-\d+$/, '')}/${other.eventIndex}`} className="text-link">{other.question}</Link></li>)}</ul></details>}
        {snapshot && <><section className="detail-panel detail-settlement" aria-label="Settlement timeline"><div className="panel-head"><h2>From prediction to payout</h2><StatusBadge kind={status}>{statusText}</StatusBadge></div>
          <p>{reality ? 'Your shares stay in your wallet while the event runs. Reality.eth accepts bonded answers and Kleros hears disputes.'
            : 'Your shares stay in your wallet while the event runs. The source rule fixes the answer. Kleros hears a challenged answer.'}</p><Stepper steps={steps} label="Settlement steps"/>
          {reality && hasRealityAnswer && <p>Current Reality.eth answer: <strong>{reality.answerLabel}</strong>. {canArbitrate ? `Challenge before ${date(reality.finalizesAt)}.` : ''}</p>}
          {reality?.pendingArbitration && <p>The answer is under Kleros review. Payout waits for the final Reality.eth result.</p>}
          {snapshot.phase === 1 && <p>Proposed answer: <strong>{labels[snapshot.proposal]}</strong>. Challenge before {date(snapshot.challengeUntil)}.</p>}
          {snapshot.phase === 2 && <p>{/^0x0{64}$/i.test(snapshot.sourceCaseId)
            ? 'Kleros case requested. If a case cannot be linked before the published deadline, this question becomes Void.'
            : 'Kleros case linked. The result waits for its final ruling.'}</p>}
          {snapshot.phase === 3 && <p>Final answer: <strong>{labels[snapshot.result]}</strong>.</p>}
          <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15}/>Refresh status</button>
        </section>
        <section className="detail-panel"><h2>What decides the answer?</h2><p>{reality ? 'The published Reality.eth question receives bonded answers. Kleros can rule on a challenged answer.'
          : 'The published source and exact rule for this question determine the provisional answer.'}</p>
          {snapshot.source?.urls?.map(url => <p key={url}><a className="text-link" href={url} target="_blank" rel="noreferrer">View source <ArrowUpRight size={14}/></a></p>)}
          <dl className="facts"><dt>Reader</dt><dd>{snapshot.source?.adapter || 'Reality.eth'}</dd><dt>Publisher</dt><dd>{snapshot.source?.publisher || 'Reality.eth'}</dd>
            <dt>Provisional evidence</dt><dd>{snapshot.proposalEvidenceURI ? <a href={snapshot.proposalEvidenceURI} target="_blank" rel="noreferrer">Read evidence</a> : 'Waiting for source'}</dd></dl>
          {reality && <p className="market-caption">Question ID: {reality.questionId}. A dedicated relay delivers the final Sepolia answer to Monad. This testnet relay remains trusted.</p>}
        </section></>}
      </div><aside className="detail-sidebar">
        <section className="detail-panel detail-trade" aria-label="Trade this market"><div className="consumer-ticket"><div className="ticket-head"><h2>{snapshot?.resolved ? 'Collect your prediction' : 'Your prediction'}</h2><p className="market-caption">Each winning share pays 1 test AUSD. Choose your answer and number of shares below.</p></div>
          {summary && !closed && <div className="detail-holdings detail-quotes"><div><span>Yes</span><strong>{summary.prices.yes ? `${cash(summary.prices.yes)} AUSD` : 'Unavailable'}</strong></div><div><span>No</span><strong>{summary.prices.no ? `${cash(summary.prices.no)} AUSD` : 'Unavailable'}</strong></div></div>}
          <div className="ticket-wallet"><div><strong className="mono">{owner ? `${owner.slice(0, 6)}...${owner.slice(-4)}` : 'Connect a trading wallet'}</strong><small>{snapshot?.user ? `${cash(snapshot.user.cashAtoms)} test AUSD` : 'MetaMask signs each trade and bond you review'}</small></div>
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => run(() => connect())}>{owner ? 'Switch wallet' : 'Connect MetaMask'}</button></div>
          {!closed && !snapshot?.resolved && <><SegmentedControl label="Buy or sell" value={mode} options={[{ value: 'buy', label: 'Buy' }, { value: 'sell', label: 'Sell' }]} onChange={value => { setMode(value); setPlan(null); }}/>
            <SegmentedControl label="Your answer" value={side} options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} onChange={value => { setSide(value); setPlan(null); }}/>
            <QuantityStepper label="Shares" value={shares} onChange={setShares} max={20}/>
            {others.length > 0 && <details><summary>Combine with another prediction</summary><label>Second question<select value={extra1} onChange={e => { setExtra1(e.target.value); setExtra2(''); }}><option value="">None</option>{others.map(item => <option key={item.id} value={item.id}>{item.question}</option>)}</select></label>
              {extra1 && <SegmentedControl label="Second answer" value={extra1Side} options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} onChange={value => setExtra1Side(value === 'no' ? 'no' : 'yes')}/>}
              {extra1 && <label>Third question<select value={extra2} onChange={e => setExtra2(e.target.value)}><option value="">None</option>{others.filter(item => item.id !== extra1).map(item => <option key={item.id} value={item.id}>{item.question}</option>)}</select></label>}
              {extra2 && <SegmentedControl label="Third answer" value={extra2Side} options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} onChange={value => setExtra2Side(value === 'no' ? 'no' : 'yes')}/>}</details>}
            {quote && <p className="market-caption">Current buy quote: {cash(quote.buyAtoms)} test AUSD. Confirm the exact amount in your wallet.</p>}
            <button className="btn btn-primary" disabled={!owner || busy || !!pending || !quote} onClick={() => run(() => prepare(mode === 'sell' ? 'sell' : needsApproval ? 'approve' : 'buy',
              { side, quantity: parseUnits(shares, 6).toString(), claim }))}>{mode === 'sell' ? 'Review sale' : needsApproval ? 'Review AUSD approval' : 'Review purchase'}</button></>}
          {snapshot?.resolved && owner && <><p>Your Yes: {cash(snapshot.user?.yesShares || '0')} shares · No: {cash(snapshot.user?.noShares || '0')} shares.</p>
            {(['yes', 'no'] as const).map(answer => BigInt(answer === 'yes' ? snapshot.user?.yesShares || '0' : snapshot.user?.noShares || '0') > 0n
              && <button key={answer} className="btn btn-secondary" disabled={busy || !!pending} onClick={() => run(() => prepare('redeem',
                { side: answer, quantity: answer === 'yes' ? snapshot.user?.yesShares : snapshot.user?.noShares }))}>Collect {answer} payout</button>)}
            {others.length > 0 && <details><summary>Collect a combined prediction</summary>
              <p className="market-caption">Select the same questions and answers you bought. Holdings and payout are read from the pool.</p>
              <SegmentedControl label="This answer" value={side} options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} onChange={value => setSide(value === 'no' ? 'no' : 'yes')}/>
              <label>Second question<select value={extra1} onChange={e => { setExtra1(e.target.value); setExtra2(''); }}><option value="">Choose a question</option>{others.map(item => <option key={item.id} value={item.id}>{item.question}</option>)}</select></label>
              {extra1 && <SegmentedControl label="Second answer" value={extra1Side} options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} onChange={value => setExtra1Side(value === 'no' ? 'no' : 'yes')}/>}
              {extra1 && <label>Third question<select value={extra2} onChange={e => setExtra2(e.target.value)}><option value="">None</option>{others.filter(item => item.id !== extra1).map(item => <option key={item.id} value={item.id}>{item.question}</option>)}</select></label>}
              {extra2 && <SegmentedControl label="Third answer" value={extra2Side} options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} onChange={value => setExtra2Side(value === 'no' ? 'no' : 'yes')}/>}
              {extra1 && <p>{combinedPosition ? `${cash(combinedPosition.holdingsAtoms)} shares held · ${cash(combinedPosition.payoutAtoms || '0')} test AUSD payable` : 'Reading this selection...'}</p>}
              {extra1 && combinedPosition && BigInt(combinedPosition.holdingsAtoms) > 0n
                && BigInt(combinedPosition.payoutAtoms || '0') > 0n
                && <button className="btn btn-secondary" disabled={busy || !!pending} onClick={() => run(() => prepare('redeem',
                  { side, claim, quantity: combinedPosition.holdingsAtoms }))}>Collect combined payout</button>}
            </details>}</>}
          <details className="disclosure"><summary>How this market works</summary><p>Trades use test AUSD on Monad. Settlement follows the published source route. Challenged results go to Kleros.</p></details></div></section>
        {snapshot?.route === 'mechanical' && snapshot.phase === 1 && snapshot.marketNow < snapshot.challengeUntil && <section className="detail-panel"><h2>Challenge this answer</h2><p>Submit a different answer and a {cash(snapshot.bondAtoms)} test AUSD bond. A challenged answer goes to Kleros.</p>
          <label>Alternative answer<select value={counter} onChange={e => setCounter(Number(e.target.value))}><option value={0}>Choose answer</option>{[1, 2, 3].filter(value => value !== snapshot.proposal).map(value => <option key={value} value={value}>{labels[value]}</option>)}</select></label>
          <label>Evidence title<input value={challenge.name} onChange={e => setChallenge(old => ({ ...old, name: e.target.value }))}/></label>
          <label>What is wrong with the proposed answer?<textarea value={challenge.description} onChange={e => setChallenge(old => ({ ...old, description: e.target.value }))}/></label>
          <label>Public source URL<input type="url" value={challenge.sourceURL} onChange={e => setChallenge(old => ({ ...old, sourceURL: e.target.value }))}/></label>
          <button className="btn btn-secondary" disabled={busy || !!pending} onClick={() => run(saveChallengeEvidence)}>Save evidence</button>
          {challengeEvidence && <><a href={challengeEvidence.uri} target="_blank" rel="noreferrer">Read saved evidence</a><button className="btn btn-primary" disabled={!owner || !counter || busy || !!pending} onClick={() => run(() => prepare('challenge',
            { counter, evidenceHash: challengeEvidence.hash, evidenceURI: challengeEvidence.uri }))}>Review challenge</button></>}
        </section>}
        {canAnswer && <section className="detail-panel"><h2>{hasRealityAnswer ? 'Post another answer' : 'Submit an answer'}</h2>
          <p>Reality.eth accepts a bonded answer on Sepolia. A different answer needs a larger bond and restarts the answer window.</p>
          <label>Answer<select value={realityAnswer} onChange={e => setRealityAnswer(e.target.value as 'yes'|'no'|'void')}><option value="yes">Yes</option><option value="no">No</option><option value="void">Void</option></select></label>
          <label>Bond in Sepolia ETH<input inputMode="decimal" value={bondEth} onChange={e => setBondEth(e.target.value)}/></label>
          <p className="market-caption">Minimum now: {formatEther(BigInt(reality!.nextBondWei))} Sepolia ETH. If another answer arrives first, your transaction may revert.</p>
          <button className="btn btn-primary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('answer', { answer: realityAnswer, bondEth }))}>Review answer and bond</button>
        </section>}
        {canArbitrate && <section className="detail-panel"><h2>Challenge this answer</h2><p>Request Kleros arbitration within the Reality.eth answer window. The fee is {formatEther(BigInt(reality!.disputeFeeWei))} Sepolia ETH.</p>
          <button className="btn btn-primary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('arbitrate'))}>Review Kleros challenge fee</button>
        </section>}
        {reality?.pendingArbitration && reality.disputeStatus === 3 && <section className="detail-panel"><h2>Complete the Kleros ruling</h2><p>Kleros has ruled. Report its result to Reality.eth from your wallet so the answer can finalize.</p>
          <button className="btn btn-primary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('finalizeArbitration'))}>Review ruling report</button></section>}
        {reality?.pendingArbitration && <section className="detail-panel"><h2>Submit evidence to Kleros</h2><p>Evidence is public and can be read by jurors. Court case #{reality.disputeId}.</p>
          <label>Evidence title<input value={challenge.name} onChange={e => setChallenge(old => ({ ...old, name: e.target.value }))}/></label>
          <label>What does this show?<textarea value={challenge.description} onChange={e => setChallenge(old => ({ ...old, description: e.target.value }))}/></label>
          <label>Public source URL<input type="url" value={challenge.sourceURL} onChange={e => setChallenge(old => ({ ...old, sourceURL: e.target.value }))}/></label>
          <button className="btn btn-secondary" disabled={busy || !!pending} onClick={() => run(saveChallengeEvidence)}>Save evidence</button>
          {challengeEvidence && <><a href={challengeEvidence.uri} target="_blank" rel="noreferrer">Read saved evidence</a><button className="btn btn-primary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('evidence', { hash: challengeEvidence.hash }))}>Review evidence submission</button></>}
        </section>}
        {reality?.pendingArbitration && reality.disputeStatus === 2 && <section className="detail-panel"><h2>Kleros appeal</h2><p>Contributions are paid in Sepolia ETH. The live court determines whether this appeal can still be funded.</p>
          <label>Ruling<select value={appealRuling} onChange={e => setAppealRuling(Number(e.target.value))}><option value={0}>Refuse to rule</option><option value={1}>No</option><option value={2}>Yes</option></select></label>
          <label>Contribution in Sepolia ETH<input inputMode="decimal" value={appealEth} onChange={e => setAppealEth(e.target.value)}/></label>
          <button className="btn btn-secondary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('appeal', { ruling: appealRuling, amountEth: appealEth }))}>Review appeal contribution</button>
        </section>}
        {reality && reality.disputeStatus >= 2 && <section className="detail-panel"><h2>Appeal rewards</h2><p>If you funded an appeal, claim eligible rewards after the court permits withdrawal.</p>
          <label>Ruling<select value={appealRuling} onChange={e => setAppealRuling(Number(e.target.value))}><option value={0}>Refuse to rule</option><option value={1}>No</option><option value={2}>Yes</option></select></label>
          <button className="btn btn-secondary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('claimAppeal', { ruling: appealRuling }))}>Check appeal rewards</button>
        </section>}
        {reality?.finalized && owner && <section className="detail-panel"><h2>Reality.eth answer bonds</h2><p>If this wallet posted an answer, process the answer history to credit eligible bond winnings.</p>
          <button className="btn btn-secondary" disabled={busy || !!pending} onClick={() => run(() => prepare('claimWinnings'))}>Review bond claim</button></section>}
        {reality && BigInt(reality.creditedEthWei) > 0n && <section className="detail-panel"><h2>Reality.eth bond credit</h2><p>{formatEther(BigInt(reality.creditedEthWei))} Sepolia ETH is ready to withdraw.</p>
          <button className="btn btn-secondary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('withdrawReality'))}>Review ETH withdrawal</button></section>}
        {snapshot?.user && BigInt(snapshot.user.bondCreditsAtoms) > 0n && <section className="detail-panel"><h2>Bond credit</h2><p>{cash(snapshot.user.bondCreditsAtoms)} test AUSD is ready to collect.</p><button className="btn btn-secondary" disabled={busy || !!pending} onClick={() => run(() => prepare('withdrawBond'))}>Review withdrawal</button></section>}
        {plan && <section className="detail-panel"><h2>Review transaction</h2><p>{plan.reason}</p><dl className="facts"><dt>Network</dt><dd>{plan.transaction.chainId === 10143 ? 'Monad testnet' : 'Sepolia'}</dd><dt>To</dt><dd>{plan.transaction.to}</dd></dl><button className="btn btn-primary" disabled={busy || !provider} onClick={() => run(confirm)}>{plan.action === 'approveBond' ? 'Allow challenge bond' : 'Confirm in MetaMask'}</button><button className="btn btn-secondary" disabled={busy} onClick={() => setPlan(null)}>Cancel</button></section>}
        {pending && <section className="detail-panel"><h2>Transaction pending</h2>
          {pending.id !== id && <p>A transaction from another market needs confirmation before the next one.</p>}
          <p>{pending.hash}</p><button className="btn btn-secondary" disabled={busy || !provider} onClick={() => run(checkPending)}>Check confirmation</button></section>}
        <section className="detail-panel detail-position"><div className="panel-head"><h2>Your position</h2><Link href="/portfolio" className="text-link">Full portfolio <ArrowUpRight size={15}/></Link></div>
          <p>Yes {cash(snapshot?.user?.yesShares || '0')} shares · No {cash(snapshot?.user?.noShares || '0')} shares.</p></section>
      </aside></div>
    </>}
  </main>;
}
