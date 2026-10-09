import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { oraclePendingKey, readOraclePending, type OraclePending } from '../pending-readers';
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
import ChoiceList from '../components/ui/ChoiceList';
import TransactionSheet from '../components/ui/TransactionSheet';
import MarketShell, { type MarketTab } from '../components/market/MarketShell';
import LinkedQuestions from '../components/market/LinkedQuestions';
import ContractList from '../components/market/ContractList';
import ComboPicker from '../components/market/ComboPicker';
import { sheetPhase } from '../sheet-state';
import { boardPrice } from '../board-cache';
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
type Pending = OraclePending;
type TradeQuote = { action: 'quote'; buyAtoms: string; maxCostAtoms: string; sellAtoms: string | null;
  allowanceAtoms: string; cashAtoms: string; holdingsAtoms: string };

const pendingKey = oraclePendingKey;
const savedPending = readOraclePending;
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

  if (!market) return <main id="main" tabIndex={-1} className="market-page">
    <nav className="market-topbar" aria-label="Breadcrumb"><Link href="/markets" className="link-back"><ArrowLeft aria-hidden="true" strokeWidth={1.75}/>All markets</Link><Link href="/fund" className="text-link">Get test funds</Link></nav>
    {error && <p className="state-inline error" role="alert">{error}</p>}
    <div className="state-block"><h1>Market not found</h1><Link href="/markets" className="btn btn-secondary">All markets</Link></div>
  </main>;
  const monadPhase = sheetPhase({ review: plan?.transaction.chainId === 10143 ? plan : null, pending: activePending?.chainId === 10143 ? activePending : null, completed: false, walletRequest: busy && plan?.transaction.chainId === 10143 });
  const sepoliaPhase = sheetPhase({ review: plan?.transaction.chainId === 11155111 ? plan : null, pending: activePending?.chainId === 11155111 ? activePending : null, completed: false, walletRequest: busy && plan?.transaction.chainId === 11155111 });
  const sheetOpen = monadPhase !== 'closed' || sepoliaPhase !== 'closed';
  const errorAlert = error ? <p className="state-inline error" role="alert">{error}</p> : null;
  const answerOptions = [{ value: 'yes' as const, label: 'Yes' }, { value: 'no' as const, label: 'No' }, { value: 'void' as const, label: 'Void or invalid' }];
  const rulingOptions = [{ value: '2', label: 'Yes' }, { value: '1', label: 'No' }, { value: '0', label: 'Refuse to rule' }];
  const defaultTab: MarketTab = closed || snapshot?.resolved || canAnswer || canArbitrate || !!snapshot?.dispute ? 'timeline' : others.length > 0 ? 'linked' : 'proof';
  const timeline = snapshot ? <section className="detail-panel detail-settlement" aria-label="Settlement timeline"><div className="panel-head"><h2>From prediction to payout</h2><StatusBadge kind={statusKind}>{statusLabel}</StatusBadge></div>
    <p>Your shares stay in your wallet while the event runs. Reality.eth accepts bonded answers, Kleros hears disputes, and Flurbo relays final answers to Monad.</p><Stepper steps={steps} label="Settlement steps"/>
    {(hasAnswer || snapshot.phase === 1) && <div className="detail-challenge"><p>Proposed answer: <strong>{snapshot.answerLabel || 'Awaiting Reality.eth'}</strong></p>{snapshot.finalizesAt > 0 && !snapshot.finalized && <p className="market-caption">Current answer may finalize {date(snapshot.finalizesAt)}. A new answer resets the countdown.</p>}</div>}
    <p className="market-caption">Each payout needs every question in this shared pool to be final.</p>
    <details className="disclosure"><summary>Settlement details</summary><dl className="oracle-facts leaders"><div><dt>Reality.eth</dt><dd>{snapshot.finalized ? 'Final' : snapshot.pendingArbitration ? 'Kleros review' : hasAnswer ? 'Bonded answer open' : 'Waiting for an answer'}</dd></div>
      {hasAnswer && <div><dt>Highest answer bond</dt><dd>{eth(snapshot.bondWei)} Sepolia ETH</dd></div>}
      <div><dt>Monad result</dt><dd>{snapshot.phase === 1 ? ['Unset', 'No', 'Yes', 'Void'][snapshot.reported] : snapshot.resolved ? 'Resolved' : 'Awaiting final answer'}</dd></div></dl>
      <p className="market-caption">A dedicated relay reports the final Sepolia answer to this Monad testnet pool. The relay can misreport until verified cross-chain delivery is added.</p></details>
    <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setRefresh(n => n + 1)}><RefreshCw size={15}/>Refresh status</button>
    {snapshot.dispute && <p className="market-caption">Kleros case #{snapshot.dispute.disputeId}: {['none', 'requested', 'created', 'ruled', 'relayed'][snapshot.dispute.status] || 'status updating'}.</p>}

    {canAnswer && !hasAnswer && <div className="oracle-settlement-action"><h3>Submit an answer</h3><p>Anyone can propose the first answer with a Sepolia ETH bond. Connect a wallet, review the answer, then sign the Reality.eth transaction in MetaMask.</p>
      <div className="oracle-fields"><SegmentedControl label="Answer" value={answer} options={answerOptions} onChange={value => setAnswer(value as typeof answer)} block/>
        <label>Bond in Sepolia ETH<input inputMode="decimal" value={bondEth} onChange={e => setBondEth(e.target.value)} /></label></div>
      <p className="market-caption">Minimum right now: {eth(snapshot.nextBondWei)} ETH. If another answer arrives first, the transaction may revert instead of paying a stale bond.</p>
      <button className="btn btn-primary" disabled={!canAnswer || !owner || busy || !!pending} onClick={() => run(() => prepare('answer', { answer, bondEth }))}>Review answer and bond</button>
    </div>}

    {canArbitrate && <div className="oracle-settlement-action"><h3>Challenge this answer</h3><p>Challenge the current Reality.eth answer through Kleros. The arbitration fee is {eth(snapshot.disputeFeeWei)} Sepolia ETH. Review it before MetaMask asks you to sign.</p>
      <button className="btn btn-primary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('arbitrate'))}>Review Kleros challenge fee</button>
      <details className="oracle-counteranswer"><summary>Post a different bonded answer instead</summary><p>Reality.eth also allows a counteranswer with a larger bond while the answer window is open. This does not start Kleros arbitration.</p>
        <div className="oracle-fields"><SegmentedControl label="Counteranswer" value={answer} options={answerOptions} onChange={value => setAnswer(value as typeof answer)} block/>
          <label>Bond in Sepolia ETH<input inputMode="decimal" value={bondEth} onChange={e => setBondEth(e.target.value)} /></label></div>
        <p className="market-caption">Minimum right now: {eth(snapshot.nextBondWei)} ETH.</p>
        <button className="btn btn-secondary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('answer', { answer, bondEth }))}>Review counteranswer bond</button>
      </details>
    </div>}

    {snapshot.dispute?.status === arbitration.ruled && snapshot.pendingArbitration && <div className="oracle-settlement-action"><h3>Complete Kleros ruling</h3><p>Kleros has ruled. Flurbo verifies Reality's answer history, then prepares the transaction that sends the ruling into Reality so the question can finalize.</p><button className="btn btn-primary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('finalizeArbitration'))}>Review ruling report</button></div>}

    {snapshot.dispute && snapshot.dispute.status >= arbitration.ruled && <div className="oracle-settlement-action"><h3>Claim appeal rewards</h3><p>If you funded an appeal, select the ruling you supported. Flurbo checks whether this wallet can withdraw its contribution or reward.</p><SegmentedControl label="Ruling funded" value={String(ruling)} options={rulingOptions} onChange={value => setRuling(Number(value))} block/><button className="btn btn-secondary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('claimAppeal', { ruling }))}>Check and claim selected ruling</button></div>}

    {snapshot.finalized && !zero(snapshot.historyHash) && <div className="oracle-settlement-action"><h3>Claim answer bonds</h3><p>If this wallet posted a Reality answer, Flurbo prepares the history transaction that credits eligible answerers. You can withdraw credited ETH from your wallet panel.</p><button className="btn btn-secondary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('claimWinnings'))}>Review bond claim</button></div>}

    {snapshot.pendingArbitration && snapshot.dispute && snapshot.dispute.status === arbitration.disputed && <div className="oracle-settlement-action"><h3>Submit evidence</h3><p>Evidence is public and identified by its content hash. Include only information you may disclose to jurors and everyone else. Saving evidence does not submit it; the on-chain submission is a separate review.</p>
      <div className="oracle-fields"><label>Title<input maxLength={120} value={evidence.name} onChange={e => setEvidence(v => ({ ...v, name: e.target.value }))}/></label>
        <label>Public source URL<input type="url" value={evidence.sourceURL} onChange={e => setEvidence(v => ({ ...v, sourceURL: e.target.value }))}/></label>
        <label className="oracle-wide">Explanation<textarea rows={5} maxLength={8000} value={evidence.description} onChange={e => setEvidence(v => ({ ...v, description: e.target.value }))}/></label></div>
      <div className="cluster"><button className="btn btn-secondary" disabled={!owner || busy || !!pending} onClick={() => run(storeEvidence)}>Save public evidence</button>
        {evidenceHash && <button className="btn btn-primary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('evidence', { hash: evidenceHash }))}>Review on-chain evidence submission</button>}</div>
    </div>}

    {snapshot.dispute?.status === arbitration.disputed && <div className="oracle-settlement-action"><h3>Fund an appeal</h3><p>Kleros appeal contributions use Sepolia ETH. Enter the amount you want to contribute. Flurbo simulates the transaction against the pinned proxy before MetaMask asks you to sign.</p>
      <div className="oracle-fields"><label>Contribution in Sepolia ETH<input inputMode="decimal" value={appealEth} onChange={e => setAppealEth(e.target.value)}/></label><SegmentedControl label="Ruling to support" value={String(ruling)} options={rulingOptions} onChange={value => setRuling(Number(value))} block/></div>
      <button className="btn btn-secondary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('appeal', { ruling, amountEth: appealEth }))}>Review appeal contribution</button></div>}
    <TransactionSheet phase={sepoliaPhase} network="Sepolia" title={sepoliaPhase === 'pending' ? 'Transaction pending' : 'Review on Sepolia'} hash={activePending?.hash} onDismiss={() => setPlan(null)} alert={sepoliaPhase !== 'closed' ? errorAlert : undefined}
      actions={sepoliaPhase === 'pending' ? <button className="btn btn-secondary" disabled={!provider || busy} onClick={() => run(checkPending)}>Check status</button>
        : plan ? <><button className="btn btn-ghost" disabled={busy} onClick={() => setPlan(null)}>Cancel review</button><button className="btn btn-primary" disabled={busy} onClick={() => run(confirm)}>Confirm in MetaMask</button></> : null}>
      {sepoliaPhase === 'pending' && activePending ? <p className="mono-break">{activePending.hash}</p>
        : plan?.transaction.chainId === 11155111 ? <section aria-label="Transaction review"><p>{plan.reason}</p><dl className="leaders"><div><dt>Destination</dt><dd className="mono-break">{plan.transaction.to}</dd></div><div><dt>Sepolia ETH</dt><dd>{eth(BigInt(plan.transaction.value).toString())}</dd></div></dl></section> : null}
    </TransactionSheet>
  </section> : <p role="status">Reading both testnets...</p>;
  const proof = snapshot ? <div className="proof-panel">
    <section className="detail-panel"><h2>What decides the answer?</h2><p>The published Reality.eth question sets the rule. Anyone can read the Sepolia question and its answer history.</p><a className="text-link" href={`https://sepolia.etherscan.io/tx/${snapshot.questionTxHash}`} target="_blank" rel="noreferrer">View source question <ArrowUpRight aria-hidden="true" strokeWidth={1.75}/></a><div className="settlement-source"><h3>What settlement reads</h3><p>Reality.eth records bonded answers for this question. A Kleros ruling settles a dispute. Flurbo relays the final answer to the Monad pool.</p><p className="mono-break">Question ID: {snapshot.questionId}</p></div><details className="disclosure"><summary>Read the resolution rules</summary><p>{market.question}</p><p>Unclear or unavailable outcomes can resolve as Void under this question's published rule.</p></details></section>
    <ContractList rows={[
      { label: 'Pool', value: snapshot.pool, href: `https://testnet.monadscan.com/address/${snapshot.pool}` },
      { label: 'Resolver', value: snapshot.resolver, href: `https://testnet.monadscan.com/address/${snapshot.resolver}` },
      { label: 'Relay', value: snapshot.relay, href: `https://testnet.monadscan.com/address/${snapshot.relay}` },
      { label: 'Reality.eth', value: snapshot.reality, href: `https://sepolia.etherscan.io/address/${snapshot.reality}` },
      { label: 'Arbitrator', value: snapshot.arbitrator, href: `https://sepolia.etherscan.io/address/${snapshot.arbitrator}` },
      { label: 'Question ID', value: snapshot.questionId },
      { label: 'Question transaction', value: snapshot.questionTxHash, href: `https://sepolia.etherscan.io/tx/${snapshot.questionTxHash}` },
    ]}/>
    <p className="market-caption">The relay can misreport until verified cross-chain delivery is added.</p>
    <details className="detail-panel"><summary>Shared pool details</summary><p className="market-caption">Payouts open when every question in this pool is final or void.</p><dl className="oracle-facts leaders"><div><dt>Settlement</dt><dd>Reality.eth and Kleros on Sepolia</dd></div><div><dt>Delivery</dt><dd>Dedicated testnet relay</dd></div></dl><a className="text-link" href={`https://testnet.monadscan.com/address/${snapshot.pool}`} target="_blank" rel="noreferrer">View pool <ArrowUpRight aria-hidden="true" strokeWidth={1.75}/></a></details>
  </div> : <p role="status" className="sr-only">Reading both testnets...</p>;
  const linked = others.length > 0 ? <LinkedQuestions current={{ yes: summary?.prices.yes ?? null }} items={others.map(other => ({ key: other.id, question: other.question, href: `/markets/oracle/${other.id}`, yes: boardPrice(auth.address, `oracle:${other.id}`) }))}>
    <p className="market-caption">These questions share one pool. Combine up to two more answers in the ticket to trade one combined position; every selected answer must be correct.</p>
  </LinkedQuestions> : undefined;
  const ticket = <>
    {snapshot && <section className="detail-panel detail-trade" aria-label="Trade this market">
      <div className="consumer-ticket"><div className="ticket-head"><h2>{snapshot.resolved ? 'Collect your prediction' : 'Your prediction'}</h2><p className="market-caption">Each correct share pays 1 test AUSD. Choose your answer and number of shares below.</p></div>
        <div className="ticket-wallet"><div><strong className="mono">{owner ? `${owner.slice(0, 6)}...${owner.slice(-4)}` : 'Connect a trading wallet'}</strong><small>{snapshot.user ? `${ausd(snapshot.user.cashAtoms)} test AUSD` : 'MetaMask signs Monad trades and Sepolia bonds'}</small></div><button className="btn btn-secondary btn-sm" disabled={busy || walletStatus === 'checking'} onClick={() => run(() => connect())}>{owner ? 'Switch wallet' : walletStatus === 'checking' ? 'Checking wallet...' : walletStatus === 'unlinked' ? 'Link selected wallet' : 'Connect MetaMask'}</button></div>
        {wallets.length > 1 && <ChoiceList label="MetaMask provider" value={String(walletChoice)} options={wallets.map((w, i) => ({ value: String(i), label: `${w.name} ${i + 1}` }))} onChange={value => { activeOwner.current = ''; setWalletChoice(Number(value)); setProvider(null); setOwner(''); setPlan(null); }} className="oracle-wallet-provider"/>}
        <div className="ticket-controls">
          {!snapshot.resolved && !closed && <SegmentedControl label="Buy or sell" value={tradeMode} options={[{ value: 'buy', label: 'Buy' }, { value: 'sell', label: 'Sell' }]} onChange={value => { setTradeMode(value); setPlan(null); }} block/>}
          <SegmentedControl label="Your answer" value={side} options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} onChange={value => { setSide(value); setPlan(null); }} block/>
          <QuantityStepper label="Shares" value={shares} max={20} onChange={value => { setShares(value); setPlan(null); }}/>
          {others.length > 0 && <details className="oracle-combination"><summary>Combine with another prediction</summary>
            <ComboPicker others={others} value={{ extra1, extra2, extra1Side, extra2Side }} onChange={next => { setExtra1(next.extra1); setExtra2(next.extra2); setExtra1Side(next.extra1Side); setExtra2Side(next.extra2Side); setPlan(null); }}/></details>}
        </div>
        {snapshot.resolved ? <p className="ticket-status">Final results are in. Review the payout for the selected shares.</p> : closed ? <p className="ticket-status">Trading has closed. Results will appear in the settlement timeline.</p>
          : !owner ? <p className="ticket-status">Connect MetaMask to see your exact quote and holdings.</p>
            : !quote ? <p className="ticket-status">Refreshing the pool price for your selection...</p>
              : <p className="ticket-status">{tradeMode === 'buy' ? `Buy quote: ${ausd(quote.buyAtoms)} test AUSD. Maximum with price tolerance: ${ausd(quote.maxCostAtoms)}.` : quote.sellAtoms === null ? 'Not enough selected shares to sell.' : `Sell quote: ${ausd(quote.sellAtoms)} test AUSD, before price tolerance.`}</p>}
        {!snapshot.resolved && !closed && <button className="text-link ticket-refresh" disabled={busy} onClick={() => setRefresh(n => n + 1)}>Refresh price</button>}
        {snapshot.resolved ? <button className="btn btn-primary btn-block" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('redeem', { side, quantity: shares, claim }))}>Review payout</button>
          : !closed && <button className="btn btn-primary btn-block oracle-ticket-action" disabled={!canTrade || (tradeMode === 'sell' && quote?.sellAtoms === null) || (tradeMode === 'buy' && !!quote && BigInt(quote.cashAtoms) < BigInt(quote.maxCostAtoms))} onClick={() => run(() => prepare(tradeMode === 'sell' ? 'sell' : needsApproval ? 'approve' : 'buy', { side, quantity: shares, claim }))}>{tradeMode === 'sell' ? 'Review sale' : needsApproval ? 'Allow payment' : 'Review purchase'}</button>}
        {quote && tradeMode === 'buy' && BigInt(quote.cashAtoms) < BigInt(quote.maxCostAtoms) && <p className="market-caption">This wallet needs more test AUSD. <Link href="/fund" className="text-link">Get test funds</Link></p>}
        <TransactionSheet phase={monadPhase} title={monadPhase === 'pending' ? 'Transaction pending' : plan?.action === 'approve' ? 'Step 1 of 2: allow this payment' : plan?.action === 'buy' ? 'Review your purchase' : plan?.action === 'sell' ? 'Review your sale' : 'Review your payout'}
          hash={activePending?.hash} onDismiss={() => setPlan(null)} alert={monadPhase !== 'closed' ? errorAlert : undefined}
          steps={plan?.action === 'approve' ? [{ label: 'Allow payment', current: true }, { label: 'Buy shares', current: false }] : undefined}
          actions={monadPhase === 'pending' ? <button className="btn btn-secondary" disabled={!provider || busy} onClick={() => run(checkPending)}>Check status</button>
            : plan ? <><button className="btn btn-ghost" disabled={busy} onClick={() => setPlan(null)}>Cancel review</button><button className="btn btn-primary" disabled={busy} onClick={() => run(confirm)}>{plan.action === 'approve' ? 'Allow payment in MetaMask' : 'Confirm in MetaMask'}</button></> : null}>
          {monadPhase === 'pending' && activePending ? <p className="mono-break">{activePending.hash}</p>
            : plan?.transaction.chainId === 10143 ? <section aria-label="Transaction review"><p className="review-claim">{plan.reason}</p><dl className="leaders"><div><dt>{plan.action === 'approve' ? 'Spending allowance' : plan.action === 'sell' ? 'Expected proceeds' : plan.action === 'redeem' ? 'Expected payout' : 'Quoted cost'}</dt><dd>{plan.amountAtoms ? `${ausd(plan.amountAtoms)} test AUSD` : 'See wallet'}</dd></div><div><dt>Network</dt><dd>Monad testnet</dd></div><div><dt>Destination</dt><dd className="mono-break">{plan.transaction.to}</dd></div></dl><p className="market-caption">Check the amount and destination. Approval alone does not buy shares.</p></section> : null}
        </TransactionSheet>
        <details className="disclosure"><summary>How this market works</summary><p>Trades use test AUSD on Monad. Reality.eth answers and Kleros disputes happen on Sepolia. Your trading wallet can sign both without leaving Flurbo.</p></details>
      </div></section>}
    <section className="detail-panel detail-position" aria-label="Your position"><div className="panel-head"><h2>Your position</h2><Link href="/portfolio" className="text-link">Other positions <ArrowUpRight aria-hidden="true" strokeWidth={1.75}/></Link></div><p className="market-caption">In your selected trading wallet</p>
      {snapshot?.user ? <dl className="position-rows leaders"><div><dt>Yes</dt><dd><strong>{ausd(snapshot.user.yesShares)} shares</strong><small>{zero(snapshot.user.yesShares) ? 'No position' : snapshot.resolved ? 'Check payout' : 'Open position'}</small></dd></div><div><dt>No</dt><dd><strong>{ausd(snapshot.user.noShares)} shares</strong><small>{zero(snapshot.user.noShares) ? 'No position' : snapshot.resolved ? 'Check payout' : 'Open position'}</small></dd></div></dl> : <p className="market-caption">Connect your wallet to see your shares.</p>}
      {selectedHoldings !== null && claim.length > 1 && <p className="market-caption">Selected combination: {selectedHoldings} shares.</p>}
      {snapshot?.user && !zero(snapshot.user.creditedEthWei) && <div className="oracle-credit"><p className="market-caption">Reality.eth bond credit: {eth(snapshot.user.creditedEthWei)} Sepolia ETH</p><button className="btn btn-secondary" disabled={busy || !!pending} onClick={() => run(() => prepare('withdraw'))}>Review ETH withdrawal</button></div>}
      <p className="market-caption">Collect this pool's payouts here after every question resolves.</p></section>
    {pending && pending.market !== id && <p className="state-inline">A transaction for another oracle market is pending. Return there to check it.</p>}
  </>;
  return <MarketShell kind="Real event" question={market.question} status={<StatusBadge kind={statusKind}>{statusLabel}</StatusBadge>} closes={{ at: market.closesAt, closed }} results={market.observationEndsAt}
    prices={summary && !closed ? summary.prices : null} watchKey={`oracle:${id}`} className="oracle-page"
    alert={<>{!sheetOpen && errorAlert}{notice && <p className="state-inline" role="status">{notice}</p>}</>}
    chart={<PriceHistory oracleId={id} event={0} pool={market.pool} refresh={refresh}/>}
    linked={linked} linkedCount={others.length + 1} timeline={timeline} proof={proof} defaultTab={defaultTab} ticket={ticket}/>;
}

