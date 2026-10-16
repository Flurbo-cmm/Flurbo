import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { hybridPendingKey, readHybridPending, type HybridPending } from '../pending-readers';
import { ArrowLeft, ArrowUpRight, RefreshCw } from 'lucide-react';
import { decodeFunctionData, formatEther, formatUnits, parseAbi, parseUnits } from 'viem';
import { appFetch } from '../platform-fetch';
import { useAuth } from '../auth/context';
import { discoverWallets, type BrowserWallet } from '../auth/wallet-choice';
import { watchTradingWallet, type TradingConnection } from '../auth/trading-session';
import { linkedWallets, linkTradingWallet } from '../wallet-links';
import SegmentedControl from '../components/ui/SegmentedControl';
import QuantityStepper from '../components/ui/QuantityStepper';
import StatusBadge, { type StatusKind } from '../components/ui/StatusBadge';
import Stepper, { type Step } from '../components/ui/Stepper';
import TransactionSheet from '../components/ui/TransactionSheet';
import MarketShell, { type MarketTab } from '../components/market/MarketShell';
import LinkedQuestions from '../components/market/LinkedQuestions';
import ContractList from '../components/market/ContractList';
import ComboPicker from '../components/market/ComboPicker';
import { sheetPhase } from '../sheet-state';
import { walletRejected } from '../wallet-errors';
import { boardPrice } from '../board-cache';
import { forgetPortfolioCachePool } from '../portfolio-cache';
import { rememberClaimHint } from '../pilot-claims';
import { credentialedReader, readerName } from '../reader-names';
import { hybridNamespace } from '../portfolio-groups';
import PriceHistory from './PriceHistory';
import { HybridConnections } from './HybridAnalysis';
import './market-detail.css';
import './pilot.css';
import './oracle.css';

const arbitration = { disputed: 1, ruled: 2 } as const;
const tradeAbi = parseAbi(['function buy(uint32,uint256,uint128,uint128,uint256) returns (uint128)',
  'function sell(uint32,uint256,uint128,uint128,uint256) returns (uint128)',
  'function redeem(uint32,uint256,uint128) returns (uint128)']);

type Market = { id: string; pool: string; poolTitle: string; eventIndex: number;
  question: string; route: 'mechanical' | 'reality'; closesAt: number; observationEndsAt: number };
type Snapshot = Market & { schema: string; resolver: string; eventHash: string; rulesHash: string;
  adapter: string; ruleAdapter?: string | null; source: { publisher?: string; urls?: string[]; adapter?: string };
  marketNow: number; funded: boolean; resolved: boolean; delivered: boolean;
  assertionDeadline: number; reportDeadline: number; bondAtoms: string;
  phase: number; proposal: number; counter: number; result: number;
  challengeUntil: number; arbitrationUntil: number; requestId: string;
  sourceCaseId: string; proposalEvidenceURI: string | null;
  reality: null | { chainId: number; reality: string; arbitrator: string; questionId: string;
    sourceNow: number; opensAt: number; finalizesAt: number; bondWei: string;
    nextBondWei: string; disputeFeeWei: string; pendingArbitration: boolean;
    finalized: boolean; creditedEthWei: string; answerLabel: string | null;
    historyHash: string; disputeStatus: number; disputeId: string;
    court: null | { court: string; disputeId: string; period: number; periodLabel: string;
      periodEndsAt: number | null; rounds: number; drawn: number; votesNeeded: number; votesCast: number;
      ruled: boolean; currentRuling: number | null;
      appeal: null | { start: number; end: number; loserEnd: number; costWei: string;
        winnerTotalWei: string; loserTotalWei: string } };
    links: { questionTx: string | null; reality: string; courtContract: string | null } };
  user: null | { wallet: string; noShares: string; yesShares: string; cashAtoms: string;
    allowanceAtoms: string; bondAllowanceAtoms: string; bondCreditsAtoms: string };
  ruleURI?: string | null;
  automaticAnswer?: { outcome: number; evidenceURI: string; observedAt: number } | null };
type Plan = { action: string; reason: string; amountAtoms?: string; maxCostAtoms?: string;
  expiresAt?: number;
  minimumReceivedAtoms?: string; transaction: { chainId: number; from: string;
  to: string; data: string; value: string } };
type Quote = { action: 'quote'; buyAtoms: string; maxCostAtoms: string;
  sellAtoms: string | null; minProceedsAtoms: string | null;
  cashAtoms: string; allowanceAtoms: string; holdingsAtoms: string };
type PositionRead = { action: 'position'; holdingsAtoms: string; payoutAtoms: string | null };
type Pending = HybridPending;

const date = (seconds: number) => new Date(seconds * 1000).toLocaleString(undefined,
  { dateStyle: 'medium', timeStyle: 'short' });
const cash = (atoms: string) => formatUnits(BigInt(atoms), 6);
const labels = ['Waiting', 'No', 'Yes', 'Void'];
const pendingKey = hybridPendingKey;
const readPending = readHybridPending;
const friendly = (error: unknown) => {
  const value = error as { message?: string };
  return walletRejected(error) ? 'Transaction cancelled in MetaMask.'
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
  const [walletStatus, setWalletStatus] = useState<TradingConnection['status']>('checking');
  const activeOwner = useRef('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [pending, setPending] = useState<Pending | null>(readPending);
  const [pendingHash, setPendingHash] = useState('');
  const [pollPaused, setPollPaused] = useState(false);
  const [combinationLink] = useState(() => new URLSearchParams(location.search).has('other'));
  const [approvalReady, setApprovalReady] = useState<string | null>(null);
  const [completed, setCompleted] = useState('');
  const pollCount = useRef(0);
  const [side, setSide] = useState<'yes' | 'no'>(() => new URLSearchParams(location.search).get('answer') === 'no' ? 'no' : 'yes');
  const [mode, setMode] = useState<'buy' | 'sell'>(() =>
    new URLSearchParams(location.search).get('trade') === 'sell' ? 'sell' : 'buy');
  const [shares, setShares] = useState(() => {
    const value = new URLSearchParams(location.search).get('shares') || '1';
    return /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value) && Number(value) > 0 && Number(value) <= 20 ? value : '1';
  });
  const [quote, setQuote] = useState<{ key: string; value: Quote } | null>(null);
  const [quoteError, setQuoteError] = useState('');
  const [combinedPosition, setCombinedPosition] = useState<PositionRead | null>(null);
  const [extra1, setExtra1] = useState(() => {
    const requested = new URLSearchParams(location.search).get('other');
    if (requested === null) return '';
    const index = Number(requested);
    return others.find(item => item.eventIndex === index)?.id || '';
  });
  const [extra2, setExtra2] = useState(() => {
    const requested = new URLSearchParams(location.search).get('third');
    if (requested === null) return '';
    const index = Number(requested);
    return others.find(item => item.eventIndex === index && item.id !== extra1)?.id || '';
  });
  const [extra1Side, setExtra1Side] = useState<'yes' | 'no'>(() =>
    new URLSearchParams(location.search).get('otherAnswer') === 'no' ? 'no' : 'yes');
  const [extra2Side, setExtra2Side] = useState<'yes' | 'no'>(() =>
    new URLSearchParams(location.search).get('thirdAnswer') === 'no' ? 'no' : 'yes');
  const [combinationRule, setCombinationRule] = useState<'AND' | 'OR' | 'EXACTLY_ONE'>(() => {
    const value = new URLSearchParams(location.search).get('rule');
    return value === 'OR' || value === 'EXACTLY_ONE' ? value : 'AND';
  });
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
    const selected = wallets[0]?.provider;
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
          setPlan(null); setApprovalReady(null); setQuote(null);
        }
        setOwner(value.owner);
        setProvider(value.owner ? selected : null);
      } });
  }, [wallets[0]?.provider, auth.address]);
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
  useEffect(() => { setChallengeEvidence(null); }, [id]);
  useEffect(() => { if (snapshot?.reality) setBondEth(formatEther(BigInt(snapshot.reality.nextBondWei)));
  }, [snapshot?.reality?.nextBondWei, snapshot?.reality?.questionId]);
  const claim = market ? [{ eventIndex: market.eventIndex, side },
    ...(extra1 ? [{ eventIndex: others.find(item => item.id === extra1)?.eventIndex ?? -1, side: extra1Side }] : []),
    ...(extra2 ? [{ eventIndex: others.find(item => item.id === extra2)?.eventIndex ?? -1, side: extra2Side }] : [])] : [];
  const selectionKey = [id, owner, mode, side, shares, extra1, extra1Side, extra2, extra2Side, combinationRule].join(':');
  const quoteKey = `${selectionKey}:${refresh}`;
  const currentQuote = quote?.key === quoteKey ? quote.value : null;
  useEffect(() => {
    if (!market) return;
    const params = new URLSearchParams(location.search);
    params.set('answer', side); params.set('shares', shares);
    if (mode === 'sell') params.set('trade', 'sell'); else params.delete('trade');
    const second = others.find(item => item.id === extra1);
    const third = others.find(item => item.id === extra2);
    if (second) { params.set('other', String(second.eventIndex)); params.set('otherAnswer', extra1Side); }
    else { params.delete('other'); params.delete('otherAnswer'); }
    if (third) { params.set('third', String(third.eventIndex)); params.set('thirdAnswer', extra2Side); }
    else { params.delete('third'); params.delete('thirdAnswer'); }
    if (second) params.set('rule', combinationRule); else params.delete('rule');
    history.replaceState(history.state, '', `${location.pathname}?${params}`);
  }, [market, side, shares, mode, extra1, extra1Side, extra2, extra2Side, combinationRule]);
  useEffect(() => {
    setPlan(null);
    setCompleted('');
    if (approvalReady && approvalReady !== selectionKey) setApprovalReady(null);
  }, [selectionKey]);
  useEffect(() => { pollCount.current = 0; setPollPaused(false); }, [pending?.hash]);
  useEffect(() => {
    if (!pending?.hash || !provider || !owner || busy || pollPaused) return;
    if (pollCount.current >= 40) { setPollPaused(true); return; }
    const timer = setTimeout(() => {
      pollCount.current += 1;
      void checkPending().catch(error => { setError(friendly(error)); setPollPaused(true); });
    }, 2500);
    return () => clearTimeout(timer);
  }, [pending, provider, owner, busy, pollPaused]);
  useEffect(() => {
    if (!market || !owner || !snapshot || snapshot.marketNow >= market.closesAt || snapshot.resolved
      || !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(shares) || Number(shares) <= 0) {
      setQuote(null); setQuoteError(''); return;
    }
    let live = true;
    setQuote(null); setQuoteError('');
    const timer = setTimeout(() => {
      void request<Quote>(id, '/action', { action: 'quote', owner,
        input: { side, rule: combinationRule, quantity: parseUnits(shares, 6).toString(), claim } })
        .then(value => { if (live) setQuote({ key: quoteKey, value }); })
        .catch(() => { if (live) setQuoteError('A current quote is unavailable. Refresh and try again.'); });
    }, 300);
    return () => { live = false; clearTimeout(timer); };
  }, [id, market, owner, snapshot?.marketNow, snapshot?.resolved, side, shares,
    extra1, extra2, extra1Side, extra2Side, combinationRule, mode, refresh]);
  useEffect(() => {
    if (!market || !owner || !snapshot?.resolved || !extra1) {
      setCombinedPosition(null); return;
    }
    let live = true;
    setCombinedPosition(null);
    void request<PositionRead>(id, '/action', { action: 'position', owner, input: { side, rule: combinationRule, claim } })
      .then(value => { if (live) setCombinedPosition(value); })
      .catch(e => { if (live) setError(friendly(e)); });
    return () => { live = false; };
  }, [id, market, owner, snapshot?.resolved, side, extra1, extra2,
    extra1Side, extra2Side, combinationRule, refresh]);

  async function connect(wallet = wallets.find(item => item.provider === provider) || wallets[0]) {
    if (!wallet || !auth.address) throw Error('Sign in and select MetaMask.');
    setBusy(true); setError(''); setPlan(null);
    try {
      if (owner) await wallet.provider.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
      const accounts = await wallet.provider.request({ method: 'eth_requestAccounts' }) as string[];
      if (!Array.isArray(accounts) || !/^0x[0-9a-f]{40}$/i.test(accounts[0] || ''))
        throw Error('Select a MetaMask account.');
      await linkTradingWallet(wallet.provider, auth.address, accounts[0]);
      activeOwner.current = accounts[0].toLowerCase();
      setProvider(wallet.provider); setOwner(accounts[0]);
      setWalletStatus('connected');
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
    if (plan.expiresAt && Date.now() / 1000 >= plan.expiresAt)
      throw Error('This price has expired. Cancel the review and get a fresh quote.');
    setBusy(true); setError('');
    try {
      const transaction = plan.transaction;
      await selectChain(provider, transaction.chainId);
      const accounts = await provider.request({ method: 'eth_accounts' }) as string[];
      if (accounts[0]?.toLowerCase() !== owner.toLowerCase()
        || transaction.from.toLowerCase() !== owner.toLowerCase())
        throw Error('MetaMask account changed. Reconnect and review again.');
      let claim: Pending['claim'];
      if (['buy', 'sell', 'redeem'].includes(plan.action)) try {
        const { args } = decodeFunctionData({ abi: tradeAbi, data: transaction.data as `0x${string}` });
        claim = { scope: Number(args[0]), mask: String(args[1]) };
      } catch { claim = undefined; }
      const intent: Pending = { hash: null, owner, id, action: plan.action,
        chainId: transaction.chainId, ...(claim ? { claim } : {}),
        ...(plan.action === 'approve' ? { approvalSelection: selectionKey } : {}) };
      sessionStorage.setItem(pendingKey, JSON.stringify(intent));
      setPending(intent);
      let hash: string;
      try {
        hash = await provider.request({ method: 'eth_sendTransaction', params: [{
          ...transaction, chainId: `0x${transaction.chainId.toString(16)}`,
        }] }) as string;
      } catch (error) {
        if (walletRejected(error)) {
          sessionStorage.removeItem(pendingKey); setPending(null);
        }
        throw error;
      }
      if (!/^0x[0-9a-f]{64}$/i.test(hash)) throw Error('Check MetaMask activity before retrying.');
      const saved = { ...intent, hash };
      sessionStorage.setItem(pendingKey, JSON.stringify(saved));
      setPending(saved); setPlan(null);
      setNotice('Transaction submitted. Confirmation is checked automatically.');
    } finally { setBusy(false); }
  }
  async function checkPending() {
    if (!pending || !provider) throw Error('Reconnect MetaMask to check this transaction.');
    if (!pending.hash) throw Error('Attach the transaction hash from MetaMask before checking.');
    if (pending.owner.toLowerCase() !== owner.toLowerCase())
      throw Error('Reconnect the wallet that submitted this transaction.');
    setBusy(true); setError('');
    try {
      await selectChain(provider, pending.chainId);
      const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [pending.hash] }) as { status?: string } | null;
      if (!receipt) return;
      sessionStorage.removeItem(pendingKey); setPending(null); setPlan(null);
      if (receipt.status === '0x1') {
        if (pending.action === 'approve' && pending.id === id)
          setApprovalReady(pending.approvalSelection || null);
        if (['buy', 'sell', 'redeem'].includes(pending.action)) {
          const tradedPool = pending.id.slice(0, 42), namespace = hybridNamespace(tradedPool);
          forgetPortfolioCachePool(namespace);
          const events = markets.filter(item => item.pool.toLowerCase() === tradedPool.toLowerCase()).length;
          if (pending.claim && events) rememberClaimHint(namespace, tradedPool, pending.owner, events, pending.claim);
        }
        if (['buy', 'sell', 'redeem'].includes(pending.action) && pending.id === id)
          setCompleted(pending.action);
        setNotice(pending.action === 'approve' ? 'Payment approval confirmed. Preparing the purchase.'
          : 'Transaction confirmed. Your position is being refreshed.');
      } else {
        setApprovalReady(null);
        setNotice('Transaction failed. Refresh the market before retrying.');
      }
      setRefresh(value => value + 1);
    } finally { setBusy(false); }
  }
  useEffect(() => {
    if (!approvalReady || approvalReady !== selectionKey || !currentQuote || pending || plan || busy
      || BigInt(currentQuote.allowanceAtoms) < BigInt(currentQuote.maxCostAtoms)) return;
    setApprovalReady(null);
    void prepare('buy', { side, rule: combinationRule, quantity: parseUnits(shares, 6).toString(), claim })
      .catch(error => setError(friendly(error)));
  }, [approvalReady, selectionKey, currentQuote, pending, plan, busy]);
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
  const statusText = snapshot?.resolved ? 'Collect' : reality?.pendingArbitration ? 'Kleros review'
    : canArbitrate ? 'Answer open for challenge' : reality?.finalized ? 'Final answer, awaiting relay'
    : reality && !hasRealityAnswer && reality.sourceNow >= reality.opensAt ? 'Awaiting bonded answer'
    : snapshot?.phase === 2 ? 'Kleros review'
    : snapshot?.phase === 1 ? 'Answer open for challenge' : snapshot?.phase === 3 ? 'Result final, awaiting pool'
      : closed ? 'Trading closed' : 'Open for predictions';
  const disputed = !!reality && reality.disputeStatus > 0;
  const courtActive = disputed || snapshot?.phase === 2;
  const finalIndex = courtActive ? 5 : 4;
  const relayIndex = finalIndex + 1;
  const payoutIndex = reality ? finalIndex + 2 : courtActive ? 6 : 5;
  const stage = reality ? snapshot?.resolved || snapshot?.phase === 3 ? payoutIndex : reality.finalized ? relayIndex
    : disputed ? 4 : hasRealityAnswer ? 3 : reality.sourceNow >= reality.opensAt ? 2 : closed ? 1 : 0
    : snapshot?.resolved ? payoutIndex : snapshot?.phase === 3 ? finalIndex
    : snapshot?.phase === 2 ? 4
    : snapshot?.phase === 1 ? 3 : snapshot && snapshot.marketNow >= snapshot.observationEndsAt ? 2 : closed ? 1 : 0;
  const step = (key: string, title: string, meta: string, index: number): Step => ({ key, title, meta,
    state: index < stage ? 'done' : index === stage ? 'current' : 'upcoming' });
  const readerLabel = snapshot?.automaticAnswer ? labels[snapshot.automaticAnswer.outcome] : null;
  const steps: Step[] = reality ? [
    step('trading', 'Trading', market ? `Closes ${date(market.closesAt)}` : '', 0),
    step('source', 'Source observed', market ? `Reader window ends ${date(market.observationEndsAt)}` : '', 1),
    step('proposal', hasRealityAnswer ? 'Answer posted' : 'Awaiting answer',
      readerLabel ? `Flurbo reader answered ${readerLabel}` : hasRealityAnswer
        ? 'A bonded answer was posted on Reality.eth' : 'An answerer must post a Sepolia ETH bond', 2),
    step('challenge', 'Challenge window', reality.finalizesAt > 0 ? `Until ${date(reality.finalizesAt)}`
      : 'Opens when the first answer is posted', 3),
    ...(disputed ? [step('court', 'Kleros review', reality.court
      ? `Case #${reality.court.disputeId}: ${reality.court.periodLabel}` : 'Jurors review the disputed answer', 4)] : []),
    step('final', 'Final on Reality.eth', 'Reality.eth finalizes the answer on Sepolia', finalIndex),
    step('relay', 'Reported to Monad', 'The relay delivers the final answer to this pool', relayIndex),
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
  const needsApproval = currentQuote && BigInt(currentQuote.allowanceAtoms) < BigInt(currentQuote.maxCostAtoms);
  const quantityAtoms = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(shares) ? parseUnits(shares, 6) : 0n;
  const canBuy = !!currentQuote && BigInt(currentQuote.cashAtoms) >= BigInt(currentQuote.maxCostAtoms);
  const canSell = !!currentQuote?.sellAtoms && BigInt(currentQuote.holdingsAtoms) >= quantityAtoms;
  const quotedAtoms = mode === 'buy' ? currentQuote?.buyAtoms : currentQuote?.sellAtoms;
  const perShare = quotedAtoms && quantityAtoms > 0n ? formatUnits(BigInt(quotedAtoms) * 1_000_000n / quantityAtoms, 6) : null;
  if (!market) return <main id="main" tabIndex={-1} className="market-page">
    <nav className="market-topbar" aria-label="Breadcrumb"><Link href="/markets" className="link-back"><ArrowLeft aria-hidden="true" strokeWidth={1.75}/>All markets</Link><Link href="/fund" className="text-link">Get test funds</Link></nav>
    <div className="state-block"><h1>Market not found</h1><Link href="/markets" className="btn btn-primary">All markets</Link></div>
  </main>;
  const tradeActions = ['approve', 'buy', 'sell', 'redeem'];
  const tradePlan = plan && tradeActions.includes(plan.action) ? plan : null, settlementPlan = plan && !tradeActions.includes(plan.action) ? plan : null;
  const tradePending = pending && tradeActions.includes(pending.action) ? pending : null, settlementPending = pending && !tradeActions.includes(pending.action) ? pending : null;
  const tradePhase = sheetPhase({ review: tradePlan, pending: tradePending, completed, walletRequest: busy && !!tradePlan });
  const settlementPhase = sheetPhase({ review: settlementPlan, pending: settlementPending, completed: false, walletRequest: busy && !!settlementPlan });
  const sheetOpen = tradePhase !== 'closed' || settlementPhase !== 'closed';
  const errorAlert = error ? <p className="state-inline error" role="alert">{error}</p> : null;
  const yesNo = [{ value: 'yes' as const, label: 'Yes' }, { value: 'no' as const, label: 'No' }];
  const rulingOptions = [{ value: '0', label: 'Refuse to rule' }, { value: '1', label: 'No' }, { value: '2', label: 'Yes' }];
  const ruleOptions = [{ value: 'AND' as const, label: 'Both (AND)' }, { value: 'OR' as const, label: 'At least one (OR)' }, { value: 'EXACTLY_ONE' as const, label: 'Exactly one' }];
  const combo = { extra1, extra2, extra1Side, extra2Side };
  const setCombo = (next: typeof combo) => { setExtra1(next.extra1); setExtra2(next.extra2); setExtra1Side(next.extra1Side); setExtra2Side(next.extra2Side); };
  const challengeOpen = snapshot?.route === 'mechanical' && snapshot.phase === 1 && snapshot.marketNow < snapshot.challengeUntil;
  const defaultTab: MarketTab = closed || !!snapshot?.resolved || (snapshot?.phase ?? 0) > 0 || canAnswer || canArbitrate || !!reality?.pendingArbitration ? 'timeline' : others.length > 0 ? 'linked' : 'proof';
  const pendingBody = (item: Pending) => <>
    {item.id !== id && <p>A transaction from another market needs confirmation before {tradeActions.includes(item.action) ? 'another trade' : 'the next one'}.</p>}
    <p>{item.hash ? 'Your transaction was sent. Confirmation is checked automatically, including after a reload.' : 'MetaMask did not return a transaction hash. If you cancelled it in MetaMask, nothing was sent. Otherwise check MetaMask activity and attach the hash below.'}</p>
    {item.hash ? <p className="mono-break">{item.hash}</p> : <label>Transaction hash<input value={pendingHash} onChange={event => setPendingHash(event.target.value)}/></label>}
    {pollPaused && <p className="field-help">Automatic checks paused. You can check again without resubmitting the trade.</p>}
  </>;
  const pendingActions = (item: Pending) => <>
    {!item.hash && <button className="btn btn-ghost" onClick={() => {
      sessionStorage.removeItem(pendingKey); setPending(null); setPendingHash(''); setError('');
    }}>Nothing was sent</button>}
    {!item.hash && <button className="btn btn-secondary" disabled={!/^0x[0-9a-f]{64}$/i.test(pendingHash)} onClick={() => {
      const saved = { ...item, hash: pendingHash };
      sessionStorage.setItem(pendingKey, JSON.stringify(saved)); setPending(saved);
    }}>Track transaction</button>}
    {!provider && <button className="btn btn-secondary" disabled={busy} onClick={() => run(() => connect())}>Reconnect MetaMask</button>}
    {item.hash && <button className="btn btn-secondary" disabled={busy || !provider} onClick={() => {
      pollCount.current = 0; setPollPaused(false); run(checkPending);
    }}>{pollPaused ? 'Check confirmation' : 'Check now'}</button>}
  </>;
  const timeline = snapshot ? <section className="detail-panel detail-settlement" aria-label="Settlement timeline"><div className="panel-head"><h2>From prediction to payout</h2><StatusBadge kind={status}>{statusText}</StatusBadge></div>
    <p>{reality ? 'Your shares stay in your wallet while the event runs. Reality.eth accepts bonded answers and Kleros hears disputes.'
      : 'Your shares stay in your wallet while the event runs. The source rule fixes the answer. Kleros hears a challenged answer.'}</p><Stepper steps={steps} label="Settlement steps"/>
    {reality?.court && <p className="market-caption">Kleros case #{reality.court.disputeId}: {reality.court.periodLabel}.
      {reality.court.periodEndsAt ? ` Ends ${date(reality.court.periodEndsAt)}.` : ''}
      {reality.court.period === 2 && reality.court.votesCast < reality.court.votesNeeded ? ' Waiting for the juror vote.' : ''}</p>}
    {reality && <p className="market-caption settlement-links">
      <a className="text-link" href={reality.links.reality} target="_blank" rel="noreferrer">Reality.eth question <ArrowUpRight size={14}/></a>
      {reality.links.courtContract && <a className="text-link" href={reality.links.courtContract} target="_blank" rel="noreferrer">Court contract on Etherscan <ArrowUpRight size={14}/></a>}
      {reality.links.questionTx && <a className="text-link" href={reality.links.questionTx} target="_blank" rel="noreferrer">Question transaction <ArrowUpRight size={14}/></a>}</p>}
    {reality && hasRealityAnswer && <p>Current Reality.eth answer: <strong>{reality.answerLabel}</strong>. {canArbitrate ? `Challenge before ${date(reality.finalizesAt)}.` : ''}</p>}
    {reality?.pendingArbitration && <p>The answer is under Kleros review. Payout waits for the final Reality.eth result.</p>}
    {snapshot.phase === 1 && <p>Proposed answer: <strong>{labels[snapshot.proposal]}</strong>. Challenge before {date(snapshot.challengeUntil)}.</p>}
    {snapshot.phase === 2 && <p>{/^0x0{64}$/i.test(snapshot.sourceCaseId)
      ? 'Kleros case requested. If a case cannot be linked before the published deadline, this question becomes Void.'
      : 'Kleros case linked. The result waits for its final ruling.'}</p>}
    {snapshot.phase === 3 && <p>Final answer: <strong>{labels[snapshot.result]}</strong>.</p>}
    <p className="market-caption">Each payout needs every question in this shared pool to be final.</p>
    <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15}/>Refresh status</button>
    {challengeOpen && <div className="oracle-settlement-action"><h3>Challenge this answer</h3><p>Submit a different answer and a {cash(snapshot.bondAtoms)} test AUSD bond. A challenged answer goes to Kleros.</p>
      <SegmentedControl label="Alternative answer" value={String(counter)} options={[1, 2, 3].filter(value => value !== snapshot.proposal).map(value => ({ value: String(value), label: labels[value] }))} onChange={value => setCounter(Number(value))} block/>
      <label>Evidence title<input value={challenge.name} onChange={e => setChallenge(old => ({ ...old, name: e.target.value }))}/></label>
      <label>What is wrong with the proposed answer?<textarea value={challenge.description} onChange={e => setChallenge(old => ({ ...old, description: e.target.value }))}/></label>
      <label>Public source URL<input type="url" value={challenge.sourceURL} onChange={e => setChallenge(old => ({ ...old, sourceURL: e.target.value }))}/></label>
      <p className="market-caption">Saving evidence publishes it publicly. Include public information only. Saving evidence does not submit a challenge.</p>
      <button className="btn btn-secondary" disabled={busy || !!pending} onClick={() => run(saveChallengeEvidence)}>Save evidence</button>
      {challengeEvidence && <><a href={challengeEvidence.uri} target="_blank" rel="noreferrer">Read saved evidence</a><button className="btn btn-primary" disabled={!owner || !counter || busy || !!pending} onClick={() => run(() => prepare('challenge',
        { counter, evidenceHash: challengeEvidence.hash, evidenceURI: challengeEvidence.uri }))}>Review challenge</button></>}
    </div>}
    {canAnswer && <div className="oracle-settlement-action"><h3>{hasRealityAnswer ? 'Post another answer' : 'Submit an answer'}</h3>
      <p>Reality.eth accepts a bonded answer on Sepolia. A different answer must at least double the current bond. {snapshot.ruleAdapter ? "If it contradicts Flurbo's published source reading, Flurbo requests Kleros arbitration automatically; you can also request it yourself." : 'Anyone can challenge a bonded answer to Kleros within the answer window.'} Needs Sepolia ETH for the bond and gas.</p>
      <SegmentedControl label="Answer" value={realityAnswer} options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }, { value: 'void', label: 'Void' }]} onChange={value => setRealityAnswer(value as 'yes'|'no'|'void')} block/>
      <label>Bond in Sepolia ETH<input inputMode="decimal" value={bondEth} onChange={e => setBondEth(e.target.value)}/></label>
      <p className="market-caption">Minimum now: {formatEther(BigInt(reality!.nextBondWei))} Sepolia ETH. If another answer arrives first, your transaction may revert.</p>
      <button className="btn btn-primary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('answer', { answer: realityAnswer, bondEth }))}>Review answer and bond</button>
    </div>}
    {canArbitrate && <div className="oracle-settlement-action"><h3>Challenge this answer</h3><p>Request Kleros arbitration within the Reality.eth answer window. The fee is {formatEther(BigInt(reality!.disputeFeeWei))} Sepolia ETH. Needs Sepolia ETH for the fee and gas.</p>
      <button className="btn btn-primary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('arbitrate'))}>Review Kleros challenge fee</button>
    </div>}
    {reality?.pendingArbitration && reality.disputeStatus === arbitration.ruled && <div className="oracle-settlement-action"><h3>Complete the Kleros ruling</h3><p>Kleros has ruled. Report its result to Reality.eth from your wallet so the answer can finalize.</p>
      <button className="btn btn-primary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('finalizeArbitration'))}>Review ruling report</button></div>}
    {reality?.pendingArbitration && <div className="oracle-settlement-action"><h3>Submit evidence to Kleros</h3><p>Evidence is public and can be read by jurors. Saving evidence does not submit it. {reality.links.courtContract ? <a className="text-link" href={reality.links.courtContract} target="_blank" rel="noreferrer">Court case #{reality.disputeId}</a> : <>Court case #{reality.disputeId}</>}.</p>
      <label>Evidence title<input value={challenge.name} onChange={e => setChallenge(old => ({ ...old, name: e.target.value }))}/></label>
      <label>What does this show?<textarea value={challenge.description} onChange={e => setChallenge(old => ({ ...old, description: e.target.value }))}/></label>
      <label>Public source URL<input type="url" value={challenge.sourceURL} onChange={e => setChallenge(old => ({ ...old, sourceURL: e.target.value }))}/></label>
      <button className="btn btn-secondary" disabled={busy || !!pending} onClick={() => run(saveChallengeEvidence)}>Save evidence</button>
      {challengeEvidence && <><a href={challengeEvidence.uri} target="_blank" rel="noreferrer">Read saved evidence</a><button className="btn btn-primary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('evidence', { hash: challengeEvidence.hash }))}>Review evidence submission</button></>}
    </div>}
    {reality?.pendingArbitration && reality.disputeStatus === arbitration.disputed && reality.court?.appeal && <div className="oracle-settlement-action"><h3>Kleros appeal</h3><p>Contributions are paid in Sepolia ETH. Current ruling: <strong>{['Refuse to rule (Void)', 'No', 'Yes'][reality.court.currentRuling ?? 0]}</strong>. Full funding: {formatEther(BigInt(reality.court.appeal.winnerTotalWei))} ETH for the current ruling, {formatEther(BigInt(reality.court.appeal.loserTotalWei))} ETH for another ruling (until {date(reality.court.appeal.loserEnd)}).</p>
      <SegmentedControl label="Ruling" value={String(appealRuling)} options={rulingOptions} onChange={value => setAppealRuling(Number(value))} block/>
      <label>Contribution in Sepolia ETH<input inputMode="decimal" value={appealEth} onChange={e => setAppealEth(e.target.value)}/></label>
      <button className="btn btn-secondary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('appeal', { ruling: appealRuling, amountEth: appealEth }))}>Review appeal contribution</button>
    </div>}
    {reality && reality.disputeStatus >= arbitration.ruled && <div className="oracle-settlement-action"><h3>Appeal rewards</h3><p>If you funded an appeal, claim eligible rewards after the court permits withdrawal.</p>
      <SegmentedControl label="Ruling" value={String(appealRuling)} options={rulingOptions} onChange={value => setAppealRuling(Number(value))} block/>
      <button className="btn btn-secondary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('claimAppeal', { ruling: appealRuling }))}>Check appeal rewards</button>
    </div>}
    {reality?.finalized && owner && !/^0x0{64}$/i.test(reality.historyHash) && <div className="oracle-settlement-action"><h3>Reality.eth answer bonds</h3><p>If this wallet posted an answer, process the answer history to credit eligible bond winnings.</p>
      <button className="btn btn-secondary" disabled={busy || !!pending} onClick={() => run(() => prepare('claimWinnings'))}>Review bond claim</button></div>}
    {reality && BigInt(reality.creditedEthWei) > 0n && <div className="oracle-settlement-action"><h3>Reality.eth bond credit</h3><p>{formatEther(BigInt(reality.creditedEthWei))} Sepolia ETH is ready to withdraw.</p>
      <button className="btn btn-secondary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('withdrawReality'))}>Review ETH withdrawal</button></div>}
    {snapshot.user && BigInt(snapshot.user.bondCreditsAtoms) > 0n && <div className="oracle-settlement-action"><h3>Bond credit</h3><p>{cash(snapshot.user.bondCreditsAtoms)} test AUSD is ready to collect.</p><button className="btn btn-secondary" disabled={busy || !!pending} onClick={() => run(() => prepare('withdrawBond'))}>Review withdrawal</button></div>}
    <TransactionSheet phase={settlementPhase} network={(settlementPlan?.transaction.chainId ?? settlementPending?.chainId) === 11155111 ? 'Sepolia' : 'Monad testnet'} title={settlementPhase === 'pending' ? 'Transaction pending' : 'Review transaction'}
      hash={settlementPending?.hash} onDismiss={() => setPlan(null)} alert={settlementPhase !== 'closed' ? errorAlert : undefined}
      actions={settlementPending ? pendingActions(settlementPending) : settlementPlan ? <><button className="btn btn-ghost" disabled={busy} onClick={() => setPlan(null)}>Cancel</button><button className="btn btn-primary" disabled={busy || !provider} onClick={() => run(confirm)}>{settlementPlan.action === 'approveBond' ? 'Allow challenge bond' : 'Confirm in MetaMask'}</button></> : null}>
      {settlementPending ? pendingBody(settlementPending) : settlementPlan ? <><p>{settlementPlan.reason}</p><dl className="leaders"><div><dt>Network</dt><dd>{settlementPlan.transaction.chainId === 10143 ? 'Monad testnet' : 'Sepolia'}</dd></div><div><dt>To</dt><dd className="mono-break">{settlementPlan.transaction.to}</dd></div></dl></> : null}
    </TransactionSheet>
  </section> : <p role="status">Reading this market...</p>;
  const readerAdapter = snapshot?.ruleAdapter ?? snapshot?.source?.adapter;
  const proof = snapshot ? <div className="proof-panel">
    <section className="detail-panel"><h2>What decides the answer?</h2><p>{reality ? 'The published Reality.eth question receives bonded answers. Kleros can rule on a challenged answer.'
      : 'The published source and exact rule for this question determine the provisional answer.'}</p>
      {reality && snapshot.ruleURI && <p><a className="text-link" href={snapshot.ruleURI} target="_blank" rel="noreferrer">Published rule <ArrowUpRight size={14}/></a></p>}
      {credentialedReader(readerAdapter) ? <p className="market-caption">This source needs credentials. The evidence holds a TLS proof of its response.</p>
        : snapshot.source?.urls?.map(url => <p key={url}><a className="text-link" href={url} target="_blank" rel="noreferrer">View source <ArrowUpRight size={14}/></a></p>)}
      <dl className="facts"><dt>Reader</dt><dd>{readerName(readerAdapter)}</dd><dt>Publisher</dt><dd>{snapshot.source?.publisher || 'Reality.eth'}</dd>
        {reality ? <><dt>Flurbo reader answer</dt><dd>{snapshot.automaticAnswer ? <a href={snapshot.automaticAnswer.evidenceURI} target="_blank" rel="noreferrer">{readerLabel}: read evidence</a> : snapshot.ruleAdapter ? 'Not recorded yet' : 'Answered on Reality.eth'}</dd></>
          : <><dt>Provisional evidence</dt><dd>{snapshot.proposalEvidenceURI ? <a href={snapshot.proposalEvidenceURI} target="_blank" rel="noreferrer">Read evidence</a> : 'Waiting for source'}</dd></>}</dl>
      {reality && <p className="market-caption">A dedicated relay delivers the final Sepolia answer to Monad. This testnet relay remains trusted and can misreport until verified cross-chain delivery is added.</p>}
    </section>
    <ContractList rows={[
      { label: 'Pool', value: snapshot.pool, href: `https://testnet.monadscan.com/address/${snapshot.pool}` },
      { label: 'Resolver', value: snapshot.resolver, href: `https://testnet.monadscan.com/address/${snapshot.resolver}` },
      { label: 'Rules hash', value: snapshot.rulesHash },
      ...(reality ? [{ label: 'Reality.eth', value: reality.reality, href: `https://sepolia.etherscan.io/address/${reality.reality}` },
        { label: 'Arbitrator', value: reality.arbitrator, href: `https://sepolia.etherscan.io/address/${reality.arbitrator}` },
        { label: 'Question ID', value: reality.questionId }] : []),
    ]}/>
  </div> : <p role="status" className="sr-only">Reading this market...</p>;
  const linked = others.length > 0 ? <LinkedQuestions current={{ yes: summary?.prices.yes ?? null }} items={others.map(item => ({ key: item.id, question: item.question, href: `/markets/hybrid/${item.pool}/${item.eventIndex}`, yes: boardPrice(auth.address, `hybrid:${item.id}`) }))}>
    <HybridConnections market={market} markets={markets}/>
    <p className="linked-thesis"><Link href={`/markets/hybrid/${market.pool}/${market.eventIndex}/thesis`} className="btn btn-secondary">Build your thesis</Link><span className="market-caption">Put your estimates beside the pool's joint outcomes and current combined-share quotes.</span></p>
  </LinkedQuestions> : undefined;
  const ticket = <>
    <section className="detail-panel detail-trade" aria-label="Trade this market"><div className="consumer-ticket"><div className="ticket-head"><h2>{snapshot?.resolved ? 'Collect your prediction' : 'Your prediction'}</h2><p className="market-caption">Each correct share pays 1 test AUSD. Choose your answer and number of shares below.</p></div>
      {!sheetOpen && errorAlert}
      {notice && <p className="state-inline" role="status">{notice}</p>}
      <div className="ticket-wallet"><div><strong className="mono">{owner ? `${owner.slice(0, 6)}...${owner.slice(-4)}` : 'Connect a trading wallet'}</strong><small>{snapshot?.user ? `${cash(snapshot.user.cashAtoms)} test AUSD` : 'MetaMask signs each trade and bond you review'}</small></div>
        <button className="btn btn-secondary btn-sm" disabled={busy || walletStatus === 'checking'} onClick={() => run(() => connect())}>{owner ? 'Switch wallet' : walletStatus === 'checking' ? 'Checking wallet...' : walletStatus === 'unlinked' ? 'Link selected wallet' : 'Connect MetaMask'}</button></div>
      {!closed && !snapshot?.resolved && !pending && !completed && <><SegmentedControl label="Buy or sell" value={mode} options={[{ value: 'buy', label: 'Buy' }, { value: 'sell', label: 'Sell' }]} onChange={value => { setMode(value); setPlan(null); }} block/>
        <SegmentedControl label="Your answer" value={side} options={yesNo} onChange={value => { setSide(value); setPlan(null); }} block/>
        <QuantityStepper label="Shares" value={shares} onChange={setShares} max={20}/>
        {others.length > 0 && <details className="oracle-combination"><summary>Combine with another prediction</summary><ComboPicker others={others} value={combo} onChange={setCombo}/></details>}
        {extra1 && <SegmentedControl label="How the answers combine" value={combinationRule} options={ruleOptions} onChange={value => setCombinationRule(value)} block/>}
        {owner && <div className="ticket-quote-state" aria-live="polite">
          {!currentQuote && <p className="ticket-status" role="status">{quoteError || 'Reading the current pool quote...'}</p>}
          <button type="button" className="text-link ticket-refresh" disabled={busy} onClick={() => setRefresh(value => value + 1)}>Refresh price</button>
        </div>}
        {currentQuote && !plan && <div className="ticket-review ticket-quote" aria-label="Current prediction quote">
          <h3>{mode === 'buy' ? 'Review your purchase' : 'Review your sale'}</h3>
          <p className="review-claim">{shares} {Number(shares) === 1 ? 'share' : 'shares'} · {extra1 ? `${combinationRule.replace('_', ' ')} · ` : ''}{claim.map(item => `${markets.find(question => question.pool.toLowerCase() === market.pool.toLowerCase() && question.eventIndex === item.eventIndex)?.question || 'Question'}: ${item.side === 'yes' ? 'Yes' : 'No'}`).join(' · ')}</p>
          {quotedAtoms && <dl className="review-figures leaders">
            <div className="review-cost"><dt>{mode === 'buy' ? 'Quoted cost' : 'Quoted proceeds'}</dt><dd>{cash(quotedAtoms)} test AUSD</dd></div>
            <div><dt>Average per share</dt><dd>{perShare} test AUSD</dd></div>
            <div><dt>{mode === 'buy' ? 'Gross payout if correct' : 'Shares leaving your wallet'}</dt><dd>{mode === 'buy' ? `${shares} test AUSD` : `${shares} shares`}</dd></div>
            <div><dt>{mode === 'buy' ? 'Maximum spend' : 'Minimum proceeds'}</dt><dd>{cash((mode === 'buy' ? currentQuote.maxCostAtoms : currentQuote.minProceedsAtoms) || '0')} test AUSD</dd></div>
            <div><dt>{mode === 'buy' ? 'Possible loss' : 'Shares held'}</dt><dd>{mode === 'buy' ? `Up to ${cash(currentQuote.maxCostAtoms)} test AUSD, plus network gas` : `${cash(currentQuote.holdingsAtoms)} shares`}</dd></div>
          </dl>}
          <p className="market-caption">0.5% price tolerance. A fresh quote is checked when you review the transaction. A correct share pays 1 test AUSD; a losing share pays 0. VOID may pay a fraction.</p>
          {mode === 'buy' && !canBuy && <p role="status">Your wallet needs at least {cash(currentQuote.maxCostAtoms)} test AUSD. <Link href="/fund" className="text-link">Get test funds</Link></p>}
          {mode === 'sell' && !canSell && <p role="status">This wallet does not hold enough shares of the selected prediction to sell.</p>}
          <button className="btn btn-primary btn-block" disabled={!owner || busy || !!pending || (mode === 'buy' ? !canBuy : !canSell)} onClick={() => run(() => prepare(mode === 'sell' ? 'sell' : needsApproval ? 'approve' : 'buy',
            { side, rule: combinationRule, quantity: quantityAtoms.toString(), claim }))}>{mode === 'sell' ? 'Review sale' : needsApproval ? 'Review AUSD approval' : 'Review purchase'}</button>
        </div>}</>}
      <TransactionSheet phase={tradePhase} hash={tradePending?.hash}
        title={tradePending ? 'Waiting for confirmation' : tradePlan ? (tradePlan.action === 'approve' ? 'Step 1 of 2: allow this payment' : tradePlan.action === 'buy' ? 'Review your purchase' : tradePlan.action === 'sell' ? 'Review your sale' : 'Review your payout') : completed === 'buy' ? 'Purchase complete' : completed === 'sell' ? 'Sale complete' : 'Payout collected'}
        onDismiss={tradePlan ? () => setPlan(null) : completed ? () => setCompleted('') : undefined} alert={tradePhase !== 'closed' ? errorAlert : undefined}
        steps={tradePlan?.action === 'approve' ? [{ label: 'Allow payment', current: true }, { label: `Buy ${shares} ${Number(shares) === 1 ? 'share' : 'shares'}`, current: false }] : undefined}
        actions={tradePending ? pendingActions(tradePending)
          : tradePlan ? <><button className="btn btn-ghost" disabled={busy} onClick={() => setPlan(null)}>Cancel review</button><button className="btn btn-primary" disabled={busy || !provider} onClick={() => run(confirm)}>{tradePlan.action === 'approve' ? 'Allow payment' : tradePlan.action === 'buy' ? `Buy ${shares} ${Number(shares) === 1 ? 'share' : 'shares'}` : tradePlan.action === 'sell' ? 'Sell shares' : 'Collect payout'}</button></>
          : completed ? <><button className="btn btn-secondary" onClick={() => setCompleted('')}>Make another trade</button><Link href="/portfolio" className="btn btn-primary">View portfolio</Link></> : null}>
        {tradePending ? <section aria-label="Pending transaction">{pendingBody(tradePending)}</section>
          : tradePlan ? <section aria-label="Transaction review">
            <p className="review-claim">{tradePlan.reason}</p>
            <dl className="review-figures leaders">
              {tradePlan.amountAtoms && <div className="review-cost"><dt>{tradePlan.action === 'approve' ? 'Allow up to' : tradePlan.action === 'buy' ? 'Spend up to' : tradePlan.action === 'sell' ? 'Receive at least' : 'Expected payout'}</dt>
                <dd>{cash(tradePlan.action === 'buy' ? tradePlan.maxCostAtoms || tradePlan.amountAtoms : tradePlan.action === 'sell' ? tradePlan.minimumReceivedAtoms || tradePlan.amountAtoms : tradePlan.amountAtoms)} test AUSD</dd></div>}
              {tradePlan.action === 'buy' && <><div><dt>Payout if correct</dt><dd>{shares} test AUSD</dd></div><div><dt>Possible loss</dt><dd>Up to {cash(tradePlan.maxCostAtoms || tradePlan.amountAtoms || '0')} test AUSD plus network fees</dd></div></>}
            </dl>
            <p>{tradePlan.action === 'approve' ? 'Approval alone does not buy shares. After it confirms, the purchase review appears here.' : 'Check this amount before confirming in MetaMask.'}</p>
            {tradePlan.expiresAt && <p className="market-caption">Review expires {date(tradePlan.expiresAt)}.</p>}
            <details><summary>Transaction details</summary><p>Network: {tradePlan.transaction.chainId === 10143 ? 'Monad testnet' : 'Sepolia'}</p><p>Destination: <span className="mono-break">{tradePlan.transaction.to}</span></p></details>
          </section>
          : completed ? <section className="ticket-done"><p>Your transaction is confirmed. The position is refreshing.</p><p className="market-caption"><a className="text-link" href="/access#notices">Email me when this settles</a></p></section> : null}
      </TransactionSheet>
      {snapshot?.resolved && owner && <><p>Your Yes: {cash(snapshot.user?.yesShares || '0')} shares · No: {cash(snapshot.user?.noShares || '0')} shares.</p>
        {(['yes', 'no'] as const).map(answer => BigInt(answer === 'yes' ? snapshot.user?.yesShares || '0' : snapshot.user?.noShares || '0') > 0n
          && <button key={answer} className="btn btn-secondary" disabled={busy || !!pending} onClick={() => run(() => prepare('redeem',
            { side: answer, quantity: answer === 'yes' ? snapshot.user?.yesShares : snapshot.user?.noShares }))}>Collect {answer} payout</button>)}
        {others.length > 0 && <details open={combinationLink}><summary>Collect a combined prediction</summary>
          <p className="market-caption">Select the same questions and answers you bought. Holdings and payout are read from the pool.</p>
          <SegmentedControl label="This answer" value={side} options={yesNo} onChange={value => setSide(value === 'no' ? 'no' : 'yes')} block/>
          <ComboPicker others={others} value={combo} onChange={setCombo} legend="Other questions in the combination"/>
          <SegmentedControl label="How the answers combine" value={combinationRule} options={ruleOptions} onChange={value => setCombinationRule(value)} block/>
          {extra1 && <p>{combinedPosition ? `${cash(combinedPosition.holdingsAtoms)} shares held · ${cash(combinedPosition.payoutAtoms || '0')} test AUSD payable` : 'Reading this selection...'}</p>}
          {extra1 && combinedPosition && BigInt(combinedPosition.holdingsAtoms) > 0n
            && BigInt(combinedPosition.payoutAtoms || '0') > 0n
            && <button className="btn btn-secondary" disabled={busy || !!pending} onClick={() => run(() => prepare('redeem',
              { side, rule: combinationRule, claim, quantity: combinedPosition.holdingsAtoms }))}>Collect combined payout</button>}
        </details>}</>}
      <details className="disclosure"><summary>How this market works</summary><p>Trades use test AUSD on Monad. Settlement follows the published source route. Challenged results go to Kleros.</p></details></div></section>
    <section className="detail-panel detail-position" aria-label="Your position"><div className="panel-head"><h2>Your position</h2><Link href="/portfolio" className="text-link">Full portfolio <ArrowUpRight size={15}/></Link></div>
      <dl className="position-rows leaders"><div><dt>Yes</dt><dd>{cash(snapshot?.user?.yesShares || '0')} shares</dd></div><div><dt>No</dt><dd>{cash(snapshot?.user?.noShares || '0')} shares</dd></div></dl></section>
  </>;
  return <MarketShell kind="Real event" question={market.question} status={<StatusBadge kind={status}>{statusText}</StatusBadge>} closes={{ at: market.closesAt, closed }} results={market.observationEndsAt}
    prices={summary && !closed ? summary.prices : null} watchKey={`hybrid:${id}`} className="oracle-page"
    alert={!snapshot && !error ? <p role="status" className="sr-only">Reading this market...</p> : undefined}
    chart={<PriceHistory hybridId={id} event={0} pool={market.pool} refresh={refresh}/>}
    linked={linked} linkedCount={others.length + 1} timeline={timeline} proof={proof} defaultTab={defaultTab} ticket={ticket}/>;
}
