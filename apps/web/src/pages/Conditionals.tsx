import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { ArrowLeft, ArrowUpRight, RefreshCw } from 'lucide-react';
import { decodeFunctionData, formatUnits, parseUnits } from 'viem';
import { useAuth } from '../auth/context';
import { discoverWallets, type BrowserWallet } from '../auth/wallet-choice';
import { watchTradingWallet, type TradingConnection } from '../auth/trading-session';
import { linkedWallets, linkTradingWallet } from '../wallet-links';
import PageHeader from '../components/PageHeader';
import ChoiceList from '../components/ui/ChoiceList';
import SegmentedControl from '../components/ui/SegmentedControl';
import QuantityStepper from '../components/ui/QuantityStepper';
import StatusBadge from '../components/ui/StatusBadge';
import TransactionSheet from '../components/ui/TransactionSheet';
import ConditionalDirectory from '../components/conditionals/ConditionalDirectory';
import DecisionView from '../components/conditionals/DecisionView';
import ConditionalTicket from '../components/conditionals/ConditionalTicket';
import ConditionalHoldings from '../components/conditionals/ConditionalHoldings';
import SettlementSummary, { type SummarySnapshot } from '../components/market/SettlementSummary';
import { settlementView } from '../settlement-timeline';
import { useLoadGate } from '../loading/gates';
import { sheetPhase } from '../sheet-state';
import { walletRejected } from '../wallet-errors';
import { APPROVAL_LABEL, balanceLabel, monadTxUrl, quoteWaitText } from '../ticket-copy';
import { exactTime, shortTime } from '../format';
import { CONDITIONAL_COPY, chanceText, legText, pairable, type Leg, type Side } from '../conditional-view';
import { condPoolAbi, conditionalCall } from '../../shared/conditionals.mjs';
import { pilotCash, pilotCashAbi } from '../../shared/pilot.mjs';
import type { ConditionalPending } from '../pending-readers';
import { ensureMonad, loadChances, loadHoldings, loadPool, loadQuestion, loadQuote, prepareConditional, questionAction, readPending, savePending, tradeInput,
  type ChancesResult, type ConditionalPlan, type ConditionalPool as PoolView, type ConditionalQuote, type Holding, type Holdings,
  type QuestionQuote } from '../conditionals-client';
import './market-detail.css';
import './pilot.css';
import './conditionals.css';

type Plan = ConditionalPlan & { kind: 'conditional' | 'question'; title: string; figures: [string, string][]; selection: string };
const cash = (atoms: string | bigint) => formatUnits(BigInt(atoms), 6);
const wholeShares = (value: string) => /^(?:[1-9]|1\d|20)$/.test(value);
const yesNo = [{ value: 'yes' as const, label: 'Yes' }, { value: 'no' as const, label: 'No' }];
const friendly = (error: unknown) => {
  const value = error as { message?: string };
  return walletRejected(error) ? 'Transaction cancelled in MetaMask.'
    : value?.message && value.message.length < 260 ? value.message : 'This request could not be completed. Refresh and try again.';
};

export default function Conditionals() {
  const [location] = useLocation();
  const pool = location.match(/^\/conditionals\/(0x[0-9a-f]{40})$/i)?.[1] ?? null;
  return pool ? <ConditionalPoolPage key={pool.toLowerCase()} pool={pool} /> : <ConditionalDirectory />;
}

function ConditionalPoolPage({ pool }: { pool: string }) {
  const { state: auth } = useAuth();
  const [view, setView] = useState<PoolView | null>(null);
  const [loadError, setLoadError] = useState(''), [reload, setReload] = useState(0);
  const [condition, setCondition] = useState<Leg>({ eventIndex: 0, side: 'yes' });
  const [target, setTarget] = useState<Leg | null>(null);
  const [chances, setChances] = useState<{ key: string; value: ChancesResult } | null>(null);
  const [chancesError, setChancesError] = useState('');
  const [wallets, setWallets] = useState<BrowserWallet[]>([]);
  const [provider, setProvider] = useState<BrowserWallet['provider'] | null>(null);
  const [owner, setOwner] = useState(''), [walletStatus, setWalletStatus] = useState<TradingConnection['status']>('checking');
  const activeOwner = useRef('');
  const [shares, setShares] = useState('1');
  const [quote, setQuote] = useState<{ key: string; value: ConditionalQuote } | null>(null);
  const [quoteError, setQuoteError] = useState(''), [quoteSlow, setQuoteSlow] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [ownSide, setOwnSide] = useState<Side>('yes'), [ownShares, setOwnShares] = useState('1');
  const [ownQuote, setOwnQuote] = useState<{ key: string; value: QuestionQuote } | null>(null);
  const [ownError, setOwnError] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [pending, setPending] = useState<ConditionalPending | null>(() => { const saved = readPending(); return saved?.pool.toLowerCase() === pool.toLowerCase() ? saved : null; });
  const [pendingHash, setPendingHash] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [completed, setCompleted] = useState<{ action: string; hash: string } | null>(null);
  const [approvalReady, setApprovalReady] = useState<string | null>(null);
  const [holdings, setHoldings] = useState<Holdings | null>(null);
  const [holdingsError, setHoldingsError] = useState(''), [holdingsLoading, setHoldingsLoading] = useState(false), [holdingsTick, setHoldingsTick] = useState(0);
  const [follow, setFollow] = useState(0);
  const [followed, setFollowed] = useState<{ eventIndex: number; value: SummarySnapshot } | null>(null);
  const [followError, setFollowError] = useState('');
  const polls = useRef(0);
  const run = (task: () => Promise<void>) => void task().catch(e => setError(friendly(e)));

  useEffect(() => {
    let live = true;
    setLoadError('');
    loadPool(pool).then(value => { if (live) setView(value); }, (e: Error & { status?: number }) => {
      if (live) setLoadError(e.status === 503 ? CONDITIONAL_COPY.unavailable : e.message);
    });
    return () => { live = false; };
  }, [pool, reload]);
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden && !busy) { setReload(value => value + 1); setRefresh(value => value + 1); } }, 60_000);
    return () => clearInterval(timer);
  }, [busy]);
  const options = view ? pairable(view.questions, condition.eventIndex) : [];
  useEffect(() => {
    if (!view) return;
    const valid = target && options.some(item => item.eventIndex === target.eventIndex && !item.disabled);
    if (!valid) {
      const next = options.find(item => !item.disabled);
      setTarget(next ? { eventIndex: next.eventIndex, side: target?.side ?? 'yes' } : null);
    }
  }, [view, condition.eventIndex]);

  useEffect(() => {
    if (!view) return;
    let live = true;
    setFollowError('');
    loadQuestion(pool, follow).then(value => { if (live) setFollowed({ eventIndex: follow, value }); }, e => { if (live) setFollowError(friendly(e)); });
    return () => { live = false; };
  }, [!!view, pool, follow, refresh]);

  useEffect(() => discoverWallets(wallet => setWallets(current => current.some(item => item.provider === wallet.provider) ? current : [...current, wallet])), []);
  useEffect(() => {
    const selected = wallets[0]?.provider;
    if (!selected || !auth.address) { activeOwner.current = ''; setOwner(''); setProvider(null); setWalletStatus('disconnected'); return; }
    return watchTradingWallet({ provider: selected, account: auth.address, links: linkedWallets, publish: value => {
      setWalletStatus(value.status);
      if (activeOwner.current !== value.owner) { activeOwner.current = value.owner; setPlan(null); setApprovalReady(null); setQuote(null); }
      setOwner(value.owner);
      setProvider(value.owner ? selected : null);
    } });
  }, [wallets[0]?.provider, auth.address]);

  const pickKey = target ? `${condition.eventIndex}:${condition.side}:${target.eventIndex}:${target.side}` : '';
  useEffect(() => {
    if (!view || !target) return;
    let live = true;
    setChancesError('');
    loadChances(pool, condition, target).then(value => { if (live) setChances({ key: pickKey, value }); },
      e => { if (live) setChancesError(friendly(e)); });
    return () => { live = false; };
  }, [view, pickKey, refresh]);

  const open = !!view && view.open;
  const selectionKey = `${pickKey}:${shares}:${owner}`;
  const quoteKey = `${selectionKey}:${refresh}`;
  const currentQuote = quote?.key === quoteKey ? quote.value : null;
  useEffect(() => {
    if (!open || !target || !wholeShares(shares)) { setQuote(null); setQuoteError(wholeShares(shares) ? '' : 'Enter one to twenty whole shares.'); return; }
    let live = true;
    setQuote(null); setQuoteError('');
    const timer = setTimeout(() => {
      loadQuote(pool, condition, target, parseUnits(shares, 6).toString(), owner || null)
        .then(value => { if (live) setQuote({ key: quoteKey, value }); }, e => { if (live) setQuoteError(friendly(e)); });
    }, 300);
    return () => { live = false; clearTimeout(timer); };
  }, [open, quoteKey]);
  useEffect(() => {
    setQuoteSlow(false);
    if (currentQuote || quoteError) return;
    const timer = setTimeout(() => setQuoteSlow(true), 10_000);
    return () => clearTimeout(timer);
  }, [currentQuote, quoteError]);
  useEffect(() => { setPlan(null); setCompleted(null); if (approvalReady && approvalReady !== selectionKey) setApprovalReady(null); }, [selectionKey]);

  const ownKey = `${condition.eventIndex}:${ownSide}:${ownShares}:${owner}:${refresh}`;
  const currentOwnQuote = ownQuote?.key === ownKey ? ownQuote.value : null;
  useEffect(() => { setOwnSide(condition.side); }, [condition.eventIndex, condition.side]);
  useEffect(() => {
    if (!open || !owner || !wholeShares(ownShares)) { setOwnQuote(null); return; }
    let live = true;
    setOwnError('');
    const timer = setTimeout(() => {
      questionAction<QuestionQuote>(pool, condition.eventIndex, 'quote', { side: ownSide, quantity: parseUnits(ownShares, 6).toString() }, owner)
        .then(value => { if (live) setOwnQuote({ key: ownKey, value }); }, e => { if (live) setOwnError(friendly(e)); });
    }, 300);
    return () => { live = false; clearTimeout(timer); };
  }, [open, ownKey]);

  useEffect(() => {
    if (!owner) { setHoldings(null); return; }
    let live = true;
    setHoldingsLoading(true); setHoldingsError('');
    loadHoldings(pool, owner).then(value => { if (live) setHoldings(value); }, e => { if (live) setHoldingsError(friendly(e)); })
      .finally(() => { if (live) setHoldingsLoading(false); });
    return () => { live = false; };
  }, [pool, owner, holdingsTick]);

  async function connect(wallet = wallets.find(item => item.provider === provider) || wallets[0]) {
    if (!wallet || !auth.address) throw Error('Sign in and select MetaMask.');
    setBusy(true); setError(''); setPlan(null);
    try {
      if (owner) await wallet.provider.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
      const accounts = await wallet.provider.request({ method: 'eth_requestAccounts' }) as string[];
      if (!Array.isArray(accounts) || !/^0x[0-9a-f]{40}$/i.test(accounts[0] || '')) throw Error('Select a MetaMask account.');
      await linkTradingWallet(wallet.provider, auth.address, accounts[0]);
      activeOwner.current = accounts[0].toLowerCase();
      setProvider(wallet.provider); setOwner(accounts[0]); setWalletStatus('connected');
      setNotice('Wallet connected. Review each transaction before signing.');
    } finally { setBusy(false); }
  }

  // The amounts shown in the review are read back from the calldata the wallet will sign.
  function reviewed(kind: Plan['kind'], value: ConditionalPlan, selection: string): Plan {
    const tx = value.transaction, events = view?.questions.length ?? 0;
    if (tx.chainId !== 10143 || tx.from.toLowerCase() !== owner.toLowerCase()) throw Error('This transaction did not pass the review check. Refresh and retry.');
    if (kind === 'question') {
      if (![pool.toLowerCase(), pilotCash].includes(tx.to.toLowerCase())) throw Error('This transaction did not pass the review check. Refresh and retry.');
      const figures: [string, string][] = value.action === 'approve' ? [['Allow up to', `${cash(value.amountAtoms ?? '0')} test AUSD`]]
        : [['Spend up to', `${cash(value.maxCostAtoms ?? value.amountAtoms ?? '0')} test AUSD`], ['Payout if correct', `${ownShares} test AUSD`]];
      return { ...value, kind, selection, figures, title: value.action === 'approve' ? 'Step 1 of 2: allow this payment' : 'Review your purchase' };
    }
    const call = conditionalCall({ to: tx.to, data: tx.data, pool, events });
    if (!call) throw Error('This transaction did not pass the review check. Refresh and retry.');
    const args = call.args as readonly bigint[];
    const figures: [string, string][] = call.name === 'approve' ? [['Allow up to', `${cash(args[1])} test AUSD`]]
      : call.name === 'buyConditional' ? [['You pay', `${cash(args[2])} test AUSD`], ['Shares', cash(args[1])],
        ['Refund if the If answer fails', `${cash(args[2])} test AUSD`]]
      : call.name === 'sellConditional' ? [['Receive at least', `${cash(args[2])} test AUSD`], ['Shares leaving your wallet', cash(args[1])]]
      : [['Expected payout', `${cash(value.amountAtoms ?? '0')} test AUSD`]];
    const title = call.name === 'approve' ? 'Step 1 of 2: allow this payment' : call.name === 'buyConditional' ? 'Review your conditional prediction'
      : call.name === 'sellConditional' ? 'Review your sale' : 'Review your payout';
    return { ...value, kind, selection, figures, title };
  }
  async function prepare(kind: Plan['kind'], action: string, input: unknown, selection = selectionKey) {
    if (!owner) throw Error('Connect MetaMask first.');
    if (pending) throw Error('Check the pending transaction first.');
    setBusy(true); setError(''); setPlan(null); setCompleted(null);
    try {
      const value = kind === 'conditional' ? await prepareConditional(pool, action, input, owner)
        : await questionAction<ConditionalPlan>(pool, condition.eventIndex, action, input, owner);
      setPlan(reviewed(kind, value, selection));
      setNotice('Review the destination and amount before signing in MetaMask.');
    } finally { setBusy(false); }
  }
  async function confirm() {
    if (!plan || !provider || !owner) throw Error('Connect MetaMask and review a transaction first.');
    if (plan.expiresAt && Date.now() / 1000 >= plan.expiresAt) throw Error('This price has expired. Cancel the review and get a fresh price.');
    setBusy(true); setError('');
    try {
      await ensureMonad(provider);
      const accounts = await provider.request({ method: 'eth_accounts' }) as string[];
      if (accounts[0]?.toLowerCase() !== owner.toLowerCase()) throw Error('MetaMask account changed. Reconnect and review again.');
      const intent: ConditionalPending = { hash: null, owner, pool, action: `${plan.kind}:${plan.action}`, chainId: 10143,
        ...(plan.action === 'approve' ? { selection: plan.selection } : {}) };
      savePending(intent); setPending(intent);
      let hash: string;
      try {
        hash = await provider.request({ method: 'eth_sendTransaction', params: [{ ...plan.transaction, chainId: '0x279f' }] }) as string;
      } catch (e) {
        if (walletRejected(e)) { savePending(null); setPending(null); }
        throw e;
      }
      if (!/^0x[0-9a-f]{64}$/i.test(hash)) throw Error('Check MetaMask activity before retrying.');
      const saved = { ...intent, hash };
      savePending(saved); setPending(saved); setPlan(null);
      setNotice('Transaction submitted. Confirmation is checked automatically.');
    } finally { setBusy(false); }
  }
  async function checkPending() {
    if (!pending || !provider) throw Error('Reconnect MetaMask to check this transaction.');
    if (!pending.hash) throw Error('Attach the transaction hash from MetaMask before checking.');
    if (pending.owner.toLowerCase() !== owner.toLowerCase()) throw Error('Reconnect the wallet that submitted this transaction.');
    setBusy(true); setError('');
    try {
      await ensureMonad(provider);
      const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [pending.hash] }) as { status?: string } | null;
      if (!receipt) return;
      savePending(null); setPending(null); setPlan(null);
      if (receipt.status === '0x1') {
        const action = pending.action.split(':')[1];
        if (action === 'approve') { setApprovalReady(pending.selection ?? null); setNotice('Payment approval confirmed. Preparing the prediction.'); }
        else { setCompleted({ action: pending.action, hash: pending.hash }); setNotice('Transaction confirmed. Your holdings are refreshing.'); }
      } else { setApprovalReady(null); setNotice('Transaction failed. Refresh the pool before retrying.'); }
      setRefresh(value => value + 1); setHoldingsTick(value => value + 1);
    } finally { setBusy(false); }
  }
  useEffect(() => { polls.current = 0; }, [pending?.hash]);
  useEffect(() => {
    if (!pending?.hash || !provider || !owner || busy || polls.current >= 40) return;
    const timer = setTimeout(() => { polls.current += 1; void checkPending().catch(e => setError(friendly(e))); }, 2500);
    return () => clearTimeout(timer);
  }, [pending, provider, owner, busy]);
  useEffect(() => {
    if (!approvalReady || !target || pending || plan || busy) return;
    const ready = approvalReady === selectionKey ? 'conditional' : approvalReady === `own:${ownKey}` ? 'question' : null;
    if (ready === 'conditional' && (!currentQuote || BigInt(currentQuote.allowanceAtoms ?? '0') < BigInt(currentQuote.payAtoms))) return;
    if (ready === 'question' && (!currentOwnQuote || BigInt(currentOwnQuote.allowanceAtoms) < BigInt(currentOwnQuote.maxCostAtoms))) return;
    if (!ready) return;
    setApprovalReady(null);
    run(() => ready === 'conditional' ? prepare('conditional', 'buy', tradeInput(condition, target, parseUnits(shares, 6).toString()))
      : prepare('question', 'buy', { side: ownSide, quantity: parseUnits(ownShares, 6).toString() }, `own:${ownKey}`));
  }, [approvalReady, selectionKey, currentQuote, currentOwnQuote, pending, plan, busy]);

  const gate = useLoadGate('conditional-pool', { pending: !view && !loadError, label: 'Loading the pool' });
  const back = <Link href="/conditionals" className="link-back"><ArrowLeft aria-hidden="true" strokeWidth={1.75} />All conditional pools</Link>;
  if (!view) return <main id="main" tabIndex={-1} className="market-page conditionals-page" aria-busy={!loadError}>
    <nav className="market-topbar" aria-label="Breadcrumb">{back}</nav>
    {loadError ? <div className="state-block" role="alert"><h1>This pool did not load</h1><p>{loadError}</p>
      <button type="button" className="btn btn-primary" onClick={() => setReload(value => value + 1)}>Try again</button></div>
      : <>{!gate.covered && <span className="progress-line" aria-hidden="true" />}<p role="status" className={gate.covered ? 'sr-only' : 'busy-text'}>Loading the pool...</p></>}
  </main>;

  const question = (eventIndex: number) => view.questions.find(item => item.eventIndex === eventIndex)?.question ?? `Question ${eventIndex + 1}`;
  const qTag = (eventIndex: number) => <span className="slip-q">Q{eventIndex + 1}</span>;
  const status = view.resolved ? <StatusBadge kind="collect">Collect</StatusBadge> : view.open ? <StatusBadge kind="open">Open for predictions</StatusBadge>
    : <StatusBadge kind="closed">Trading closed</StatusBadge>;
  const values = chances?.key === pickKey ? chances.value : null;
  const disabledThen = options.some(item => item.disabled);
  const phase = sheetPhase({ review: plan, pending, completed: completed?.action, walletRequest: busy && !!plan });
  const errorAlert = error ? <p className="state-inline error" role="alert">{error}</p> : null;
  const sheetOpen = phase !== 'closed';
  const ownPay = currentOwnQuote ? BigInt(currentOwnQuote.maxCostAtoms) : null;
  const ownNeedsApproval = !!currentOwnQuote && BigInt(currentOwnQuote.allowanceAtoms) < BigInt(currentOwnQuote.maxCostAtoms);
  const wallet = <div className="ticket-wallet"><div><strong className="mono">{owner ? `${owner.slice(0, 6)}...${owner.slice(-4)}` : 'Connect a trading wallet'}</strong>
    <small>{balanceLabel({ owner: owner || null, snapshotLoaded: !!currentQuote?.cashAtoms, cashAtoms: currentQuote?.cashAtoms ?? null, error: false })}</small></div>
    <button type="button" className="btn btn-secondary btn-sm" disabled={busy || walletStatus === 'checking'} onClick={() => run(() => connect())}>
      {owner ? 'Switch wallet' : walletStatus === 'checking' ? 'Checking wallet...' : walletStatus === 'unlinked' ? 'Link selected wallet' : 'Connect MetaMask'}</button></div>;
  const followedSnapshot = followed?.eventIndex === follow ? followed.value : null;
  const followedQuestion = view.questions.find(item => item.eventIndex === follow);
  const settlement = settlementView({ snapshot: followedSnapshot, closesAt: view.closesAt, observationEndsAt: followedQuestion?.observationEndsAt ?? view.closesAt,
    now: Date.now() / 1000, format: exactTime });
  const followPicker = <ChoiceList label="Question to follow" value={String(follow)} className="cond-choices"
    options={view.questions.map(item => ({ value: String(item.eventIndex), text: item.question,
      label: <span className="cond-choice">{qTag(item.eventIndex)}<span>{item.question}
        <small className="cond-choice-note">Answers from {shortTime(item.observationEndsAt)}</small></span></span> }))}
    onChange={value => setFollow(Number(value))} />;
  const realityLink = followedSnapshot?.reality?.links.reality;
  const settlementAction = realityLink && (settlement.canArbitrate || settlement.canAnswer) ? <div className="cond-settle-action">
    <p>{settlement.canArbitrate ? `Anyone can post a different answer with at least double the bond, or request Kleros arbitration, until ${exactTime(followedSnapshot!.reality!.finalizesAt)}.`
      : 'Anyone can post the first bonded answer. A different answer can then be posted with a larger bond, and Kleros hears a challenge.'} Needs Sepolia ETH for the bond and gas.</p>
    <a className="btn btn-secondary btn-sm" href={realityLink} target="_blank" rel="noreferrer">{settlement.canArbitrate ? 'Challenge on Reality.eth' : 'Answer on Reality.eth'}<ArrowUpRight size={15} aria-hidden="true" /></a>
  </div> : null;
  // Beside the ticket, focus stays on the branch and the ticket announces its new price; on phones the ticket comes into view.
  const predict = (side: Side) => {
    setCondition(value => ({ ...value, side }));
    if (window.innerWidth >= 1024) return;
    requestAnimationFrame(() => {
      const heading = document.getElementById('cond-ticket-heading');
      heading?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      heading?.focus({ preventScroll: true });
    });
  };
  const sell = (row: Holding) => run(() => prepare('conditional', 'sell', { shape: row.shape,
    shares: (BigInt(row.sharesAtoms) > 20_000_000n ? 20_000_000n : BigInt(row.sharesAtoms)).toString() }, `holding:${row.key}`));
  const collect = (row: Holding) => run(() => prepare('conditional', 'redeem', { shape: row.shape }, `holding:${row.key}`));

  return <main id="main" tabIndex={-1} className="market-page conditionals-page">
    <nav className="market-topbar" aria-label="Breadcrumb">{back}<Link href="/fund" className="text-link">Get test funds</Link></nav>
    <PageHeader className="cond-pool-header" title={view.title} lead={CONDITIONAL_COPY.lead}
      meta={<p className="market-meta"><span>{view.questions.length} questions</span>
        <span>{view.open ? 'Closes' : 'Closed'} <time dateTime={new Date(view.closesAt * 1000).toISOString()}>{exactTime(view.closesAt)}</time></span>{status}</p>} />
    <div className="cond-columns">
      <section className="cond-build" aria-label="Build a conditional" data-conditional-section="build">
        <div className="cond-clause">
          <div className="cond-lead"><h2 className="cond-word">If</h2>
            <div className="cond-answer"><span aria-hidden="true">is</span>
              <SegmentedControl label="If answer" hideLabel value={condition.side} options={yesNo} onChange={side => setCondition(current => ({ ...current, side }))} /></div></div>
          <ChoiceList label="If this question" hideLabel value={String(condition.eventIndex)} className="cond-choices"
            options={view.questions.map(item => ({ value: String(item.eventIndex), text: item.question,
              label: <span className="cond-choice">{qTag(item.eventIndex)}<span>{item.question}</span></span>, meta: chanceText(item.chance) }))}
            onChange={value => setCondition(current => ({ ...current, eventIndex: Number(value) }))} />
        </div>
        <div className="cond-clause">
          <div className="cond-lead"><h2 className="cond-word">Then</h2>
            {target && <div className="cond-answer"><span aria-hidden="true">is</span>
              <SegmentedControl label="Then answer" hideLabel value={target.side} options={yesNo} onChange={side => setTarget(current => current && ({ ...current, side }))} /></div>}</div>
          {options.length ? <ChoiceList label="Then this question" hideLabel value={target ? String(target.eventIndex) : null} className="cond-choices"
            options={options.map(item => ({ value: String(item.eventIndex), text: item.question, disabled: item.disabled,
              label: <span className="cond-choice">{qTag(item.eventIndex)}<span>{item.question}
                {item.disabled && <small className="cond-choice-note">Cannot pair with Q{condition.eventIndex + 1} in this pool</small>}</span></span>,
              meta: chanceText(view.questions.find(q => q.eventIndex === item.eventIndex)?.chance ?? null) }))}
            onChange={value => setTarget(current => ({ eventIndex: Number(value), side: current?.side ?? 'yes' }))} />
            : <p className="market-caption">This pool has no other question to pair.</p>}
          {disabledThen && <p className="cond-limit" role="note">Why some questions cannot be chosen: {view.combinationLimit}</p>}
        </div>
      </section>
      {target ? <DecisionView condition={condition} target={target} conditionQuestion={question(condition.eventIndex)} values={values?.values ?? null}
        reasons={values?.reasons ?? {}} loading={!values && !chancesError} error={chancesError} onPredict={predict} />
        : <section className="cond-fork" aria-label="Both cases" data-conditional-section="decision"><p className="cond-limit" role="note">{view.combinationLimit}</p></section>}
      {target && <ConditionalTicket condition={condition} target={target} conditionQuestion={question(condition.eventIndex)} targetQuestion={question(target.eventIndex)}
        wallet={wallet} shares={shares} onShares={setShares} quote={currentQuote} quoteError={quoteError} quoteSlow={quoteSlow} open={open} owner={owner}
        busy={busy} blocked={!!pending} notice={sheetOpen ? '' : notice} alert={sheetOpen ? null : errorAlert}
        onReview={action => run(() => prepare('conditional', action, tradeInput(condition, target, parseUnits(shares, 6).toString())))}
        onRefresh={() => setRefresh(value => value + 1)} />}
      <section className="detail-panel cond-own" aria-label="Trade the If question" data-conditional-section="condition">
        <div className="cond-own-about">
          <div className="ticket-head"><h2>Trade the If question</h2><p className="market-caption">{CONDITIONAL_COPY.conditionTicket}</p></div>
          <p className="cond-own-question">{qTag(condition.eventIndex)}<span>{question(condition.eventIndex)}</span></p>
        </div>
        {open ? <div className="cond-own-trade">
          <SegmentedControl label="Your answer" value={ownSide} options={yesNo} onChange={side => setOwnSide(side)} block />
          <QuantityStepper label="Shares of the If question" value={ownShares} onChange={setOwnShares} max={20} />
          {!owner ? <p className="market-caption">Connect MetaMask above to price this question.</p>
            : ownError ? <p className="ticket-status ticket-status-error" role="status">{ownError}</p>
            : !currentOwnQuote ? <p className="ticket-status" role="status">{quoteWaitText(false)}</p>
            : <dl className="leaders"><div><dt>Spend up to</dt><dd>{cash(currentOwnQuote.maxCostAtoms)} test AUSD</dd></div>
              <div><dt>Payout if correct</dt><dd>{ownShares} test AUSD</dd></div></dl>}
          <button type="button" className="btn btn-secondary btn-block" disabled={!owner || busy || !!pending || !currentOwnQuote
            || BigInt(currentOwnQuote.cashAtoms) < (ownPay ?? 0n)}
            onClick={() => run(() => prepare('question', ownNeedsApproval ? 'approve' : 'buy', { side: ownSide, quantity: parseUnits(ownShares, 6).toString() }, `own:${ownKey}`))}>
            {ownNeedsApproval ? APPROVAL_LABEL : `Review ${legText({ ...condition, side: ownSide })}`}</button>
        </div> : <p className="market-caption cond-own-trade">Trading in this pool is closed.</p>}
      </section>
    </div>
    <ConditionalHoldings owner={owner} holdings={holdings} loading={holdingsLoading} error={holdingsError} busy={busy || !!pending}
      onSell={sell} onCollect={collect} onRetry={() => setHoldingsTick(value => value + 1)} />
    <div className="cond-settlement" data-conditional-section="settlement">
      {followedSnapshot ? <SettlementSummary snapshot={followedSnapshot} view={settlement} format={exactTime} picker={followPicker}>{settlementAction}</SettlementSummary>
        : <section className="detail-panel detail-settlement" aria-label="Settlement timeline"><div className="panel-head"><h2>From prediction to payout</h2></div>
          {followPicker}
          {followError ? <p className="state-inline error" role="alert">{followError} <button type="button" className="text-link" onClick={() => setRefresh(value => value + 1)}>Retry</button></p>
            : <p role="status" className="market-caption">Reading this question...</p>}</section>}
    </div>
    <p className="cond-refresh"><button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => { setReload(value => value + 1); setRefresh(value => value + 1); }}>
      <RefreshCw size={15} aria-hidden="true" />Refresh the pool</button></p>
    <TransactionSheet phase={phase} hash={pending?.hash ?? null}
      title={pending ? 'Waiting for confirmation' : plan ? plan.title : 'Transaction confirmed'}
      onDismiss={plan ? () => setPlan(null) : completed ? () => setCompleted(null) : undefined} alert={sheetOpen ? errorAlert : undefined}
      steps={plan?.action === 'approve' ? [{ label: 'Allow payment', current: true }, { label: plan.kind === 'conditional' ? 'Predict' : 'Buy', current: false }] : undefined}
      actions={pending ? <>
          {!pending.hash && <button type="button" className="btn btn-ghost" onClick={() => { savePending(null); setPending(null); setPendingHash(''); setError(''); }}>Nothing was sent</button>}
          {!pending.hash && <button type="button" className="btn btn-secondary" disabled={!/^0x[0-9a-f]{64}$/i.test(pendingHash)}
            onClick={() => { const saved = { ...pending, hash: pendingHash }; savePending(saved); setPending(saved); }}>Track transaction</button>}
          {!provider && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => run(() => connect())}>Reconnect MetaMask</button>}
          {pending.hash && <button type="button" className="btn btn-secondary" disabled={busy || !provider} onClick={() => { polls.current = 0; run(checkPending); }}>Check now</button>}
        </>
        : plan ? <><button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setPlan(null)}>Cancel review</button>
          <button type="button" className="btn btn-primary" disabled={busy || !provider} onClick={() => run(confirm)}>{plan.action === 'approve' ? 'Allow payment' : 'Confirm in MetaMask'}</button></>
        : completed ? <><button type="button" className="btn btn-secondary" onClick={() => setCompleted(null)}>Done</button><Link href="/portfolio" className="btn btn-primary">View portfolio</Link></> : null}>
      {pending ? <section aria-label="Pending transaction">
          <p>{pending.hash ? 'Your transaction was sent. Confirmation is checked automatically, including after a reload.'
            : 'MetaMask did not return a transaction hash. If you cancelled it in MetaMask, nothing was sent. Otherwise check MetaMask activity and attach the hash below.'}</p>
          {pending.hash ? <p className="mono-break">{pending.hash}</p> : <label>Transaction hash<input value={pendingHash} onChange={event => setPendingHash(event.target.value)} /></label>}
        </section>
        : plan ? <section aria-label="Transaction review">
          <p className="review-claim">{plan.kind === 'conditional' && target && plan.action === 'buy'
            ? `If ${legText(condition)}, then ${legText(target)}` : plan.reason}</p>
          <dl className="review-figures leaders">{plan.figures.map(([label, value], i) => <div key={label} className={i === 0 ? 'review-cost' : undefined}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
          <p>{plan.action === 'approve' ? 'Approval alone buys nothing. After it confirms, the next review appears here.' : 'Check this amount before confirming in MetaMask.'}</p>
          {plan.expiresAt && <p className="market-caption">Review expires {exactTime(plan.expiresAt)}.</p>}
          <details><summary>Transaction details</summary><p>Network: Monad testnet</p><p>Destination: <span className="mono-break">{plan.transaction.to}</span></p>
            <p>Call: <span className="mono-break">{describeCall(plan)}</span></p></details>
        </section>
        : completed ? <section className="ticket-done"><p>Your transaction is confirmed. Holdings are refreshing.</p>
          {monadTxUrl(completed.hash) && <p className="market-caption"><a className="text-link" href={monadTxUrl(completed.hash)!} target="_blank" rel="noreferrer">View transaction on Monadscan <ArrowUpRight size={14} /></a></p>}</section> : null}
    </TransactionSheet>
  </main>;
}

function describeCall(plan: Plan) {
  try {
    const abi = plan.transaction.to.toLowerCase() === pilotCash ? pilotCashAbi : condPoolAbi;
    return decodeFunctionData({ abi, data: plan.transaction.data as `0x${string}` }).functionName;
  } catch { return plan.action; }
}
