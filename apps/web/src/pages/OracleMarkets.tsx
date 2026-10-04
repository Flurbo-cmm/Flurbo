import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { ArrowLeft, RefreshCw, ShieldCheck } from 'lucide-react';
import { formatEther, formatUnits } from 'viem';
import { appFetch } from '../platform-fetch';
import { useAuth } from '../auth/context';
import { discoverWallets, type BrowserWallet } from '../auth/wallet-choice';
import { linkTradingWallet } from '../wallet-links';
import { type OracleMarket, type OracleMarketSummary } from '../market-directory';
import './market-detail.css';
import './oracle.css';

type OracleUser = { wallet: string; creditedEthWei: string; noShares: string; yesShares: string;
  cashAtoms: string; allowanceAtoms: string };
type OracleSnapshot = OracleMarket & { schema: string; reality: string; arbitrator: string;
  questionId: string; resolver: string; relay: string; historyHash: string;
  answer: string | null; answerLabel: string | null;
  bondWei: string; minBondWei: string; nextBondWei: string; disputeFeeWei: string;
  opensAt: number; finalizesAt: number; sourceNow: number; marketNow: number;
  finalized: boolean; pendingArbitration: boolean; dispute: null | { status: number; disputeId: string; ruling: string };
  reportDeadline: number; phase: number; reported: number; funded: boolean; resolved: boolean;
  user: OracleUser | null };
type OraclePlan = { action: string; reason: string; amountWei?: string; amountAtoms?: string;
  transaction: { chainId: number; from: string; to: string; data: string; value: string } };
type Pending = { hash: string; chainId: number; action: string; owner: string; market: string };

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
  const [provider, setProvider] = useState<BrowserWallet['provider'] | null>(null);
  const [owner, setOwner] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<OraclePlan | null>(null);
  const [pending, setPending] = useState<Pending | null>(savedPending);
  const [refresh, setRefresh] = useState(0);
  const [side, setSide] = useState<'yes' | 'no'>(() => new URLSearchParams(window.location.search).get('answer') === 'no' ? 'no' : 'yes');
  const [shares, setShares] = useState('1');
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

  async function connect(wallet = wallets.find(item => item.provider === provider) || wallets[0]) {
    if (!wallet) throw Error('Install MetaMask or open Flurbo in its browser.');
    if (!auth.address) throw Error('Sign in first.');
    setBusy(true); setError(''); setOwner(''); setProvider(null); setPlan(null);
    try {
      if (owner) await wallet.provider.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
      const accounts = await wallet.provider.request({ method: 'eth_requestAccounts' }) as string[];
      if (!Array.isArray(accounts) || !/^0x[0-9a-f]{40}$/i.test(accounts[0] || '')) throw Error('Select a MetaMask account.');
      setNotice('Confirm the account link in MetaMask if requested.');
      await linkTradingWallet(wallet.provider, auth.address, accounts[0]);
      setProvider(wallet.provider); setOwner(accounts[0]);
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
    }).then(value => { if (live) setPosition(value.holdingsAtoms); })
      .catch(() => { if (live) setPosition(null); });
    return () => { live = false; };
  }, [id, owner, market, side, extra1, extra2, extra1Side, extra2Side, refresh]);
  const activePending = pending?.market === id ? pending : null;
  const canAnswer = snapshot && !snapshot.finalized && !snapshot.pendingArbitration && snapshot.sourceNow >= snapshot.opensAt
    && (zero(snapshot.bondWei) || snapshot.sourceNow < snapshot.finalizesAt);
  const canArbitrate = snapshot && !snapshot.finalized && !snapshot.pendingArbitration && !zero(snapshot.bondWei)
    && snapshot.sourceNow < snapshot.finalizesAt;
  const hasAnswer = snapshot && !zero(snapshot.bondWei);

  return <main id="main" tabIndex={-1} className="page markets-page market-detail oracle-page">
    <nav className="detail-breadcrumb" aria-label="Breadcrumb"><Link href="/markets" className="link-back"><ArrowLeft size={18}/>All markets</Link></nav>
    {error && !market && <p className="state-inline error" role="alert">{error}</p>}
    {!market && <div className="state-block"><h1>Market not found</h1><Link href="/markets" className="btn btn-secondary">All markets</Link></div>}
    {market && <>
      <header className="detail-heading"><span className="chip">Monad testnet · Reality.eth on Sepolia</span><h1>{market.question}</h1>
        <p>Trading closes {date(market.closesAt)}. The source can be answered after {date(market.observationEndsAt)}.</p></header>
      <div className="oracle-columns"><div className="oracle-main">
        {error && <p className="state-inline error" role="alert">{error}</p>}
        {notice && <p className="state-inline" role="status">{notice}</p>}
        {!snapshot && !error && <p role="status">Reading both testnets...</p>}
        {snapshot && <>
          <section className="detail-panel"><div className="panel-head"><h2>Current result</h2><button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setRefresh(n => n + 1)}><RefreshCw size={15}/>Refresh</button></div>
            <dl className="oracle-facts"><div><dt>Resolution</dt><dd>{snapshot.finalized ? 'Final' : snapshot.pendingArbitration ? 'Kleros arbitration pending' : hasAnswer ? canArbitrate ? 'Answer open for challenge' : 'Answer awaiting finality' : canAnswer ? 'Open for answers' : 'Waiting for observation'}</dd></div>
              {hasAnswer && <div><dt>Proposed answer</dt><dd>{snapshot.answerLabel || 'Not available'}</dd></div>}
              {hasAnswer && <div><dt>Highest bond</dt><dd>{eth(snapshot.bondWei)} Sepolia ETH</dd></div>}
              {canArbitrate && <div><dt>Arbitration fee</dt><dd>{eth(snapshot.disputeFeeWei)} Sepolia ETH</dd></div>}
              <div><dt>Flurbo result</dt><dd>{snapshot.phase === 1 ? ['Unset','No','Yes','Void'][snapshot.reported] : 'Awaiting relay'}</dd></div></dl>
            {snapshot.finalizesAt > 0 && !snapshot.finalized && <p className="market-caption">Current Reality answer may finalize {date(snapshot.finalizesAt)}. A new answer resets the countdown.</p>}
            {snapshot.dispute && <p className="market-caption">Kleros case: {['none','requested','created','ruled','relayed'][snapshot.dispute.status] || 'status updating'}, dispute #{snapshot.dispute.disputeId}.</p>}
            <p className="market-caption">This testnet pool relies on a dedicated relay to deliver the final Sepolia answer to Monad. The relay can still misreport until verified cross-chain delivery is added.</p>
          </section>

          {canAnswer && !hasAnswer && <section className="detail-panel"><h2>Submit an answer</h2><p>Propose the first answer on Reality.eth with a Sepolia ETH bond. MetaMask stays on Flurbo throughout.</p>
            <div className="oracle-fields"><label>Answer<select value={answer} onChange={e => setAnswer(e.target.value as typeof answer)}><option value="yes">Yes</option><option value="no">No</option><option value="void">Void or invalid</option></select></label>
              <label>Bond in Sepolia ETH<input inputMode="decimal" value={bondEth} onChange={e => setBondEth(e.target.value)} /></label></div>
            <p className="market-caption">Minimum right now: {eth(snapshot.nextBondWei)} ETH. If another answer arrives first, the transaction may revert instead of paying a stale bond.</p>
            <button className="btn btn-primary" disabled={!canAnswer || !owner || busy || !!pending} onClick={() => run(() => prepare('answer', { answer, bondEth }))}>Review answer and bond</button>
          </section>}

          {canArbitrate && <section className="detail-panel"><h2>Challenge this answer</h2><p>Challenge the current Reality.eth answer through Kleros. The arbitration fee is paid in Sepolia ETH. Review it before MetaMask asks you to sign.</p>
            <button className="btn btn-primary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('arbitrate'))}>Review Kleros challenge fee</button>
            <details className="oracle-counteranswer"><summary>Post a different bonded answer instead</summary><p>Reality.eth also allows a counteranswer with a larger bond while the answer window is open. This does not start Kleros arbitration.</p>
              <div className="oracle-fields"><label>Counteranswer<select value={answer} onChange={e => setAnswer(e.target.value as typeof answer)}><option value="yes">Yes</option><option value="no">No</option><option value="void">Void or invalid</option></select></label>
                <label>Bond in Sepolia ETH<input inputMode="decimal" value={bondEth} onChange={e => setBondEth(e.target.value)} /></label></div>
              <p className="market-caption">Minimum right now: {eth(snapshot.nextBondWei)} ETH.</p>
              <button className="btn btn-secondary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('answer', { answer, bondEth }))}>Review counteranswer bond</button>
            </details>
          </section>}

          {snapshot.dispute?.status === 3 && snapshot.pendingArbitration && <section className="detail-panel"><h2>Complete Kleros ruling</h2><p>Kleros has ruled. Flurbo verifies Reality's answer history, then prepares the transaction that sends the ruling into Reality so the question can finalize.</p><button className="btn btn-primary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('finalizeArbitration'))}>Review ruling report</button></section>}

          {snapshot.dispute && snapshot.dispute.status >= 3 && <section className="detail-panel"><h2>Claim appeal rewards</h2><p>If you funded an appeal, select the ruling you supported. Flurbo checks whether this wallet can withdraw its contribution or reward.</p><label>Ruling funded<select value={ruling} onChange={e => setRuling(Number(e.target.value))}><option value={2}>Yes</option><option value={1}>No</option><option value={0}>Refuse to rule / invalid</option></select></label><button className="btn btn-secondary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('claimAppeal', { ruling }))}>Check and claim selected ruling</button></section>}

          {snapshot.finalized && !zero(snapshot.historyHash) && <section className="detail-panel"><h2>Claim answer bonds</h2><p>If this wallet posted a Reality answer, Flurbo prepares the history transaction that credits eligible answerers. You can withdraw credited ETH from your wallet panel.</p><button className="btn btn-secondary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('claimWinnings'))}>Review bond claim</button></section>}

          {snapshot.pendingArbitration && snapshot.dispute && snapshot.dispute.status <= 2 && <section className="detail-panel"><h2>Submit evidence</h2><p>Evidence is public and identified by its content hash. Include only information you may disclose to jurors and everyone else.</p>
            <div className="oracle-fields"><label>Title<input maxLength={120} value={evidence.name} onChange={e => setEvidence(v => ({ ...v, name: e.target.value }))}/></label>
              <label>Public source URL<input type="url" value={evidence.sourceURL} onChange={e => setEvidence(v => ({ ...v, sourceURL: e.target.value }))}/></label>
              <label className="oracle-wide">Explanation<textarea rows={5} maxLength={8000} value={evidence.description} onChange={e => setEvidence(v => ({ ...v, description: e.target.value }))}/></label></div>
            <div className="cluster"><button className="btn btn-secondary" disabled={!owner || busy || !!pending} onClick={() => run(storeEvidence)}>Save public evidence</button>
              {evidenceHash && <button className="btn btn-primary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('evidence', { hash: evidenceHash }))}>Review on-chain evidence submission</button>}</div>
          </section>}

          {snapshot.dispute?.status === 2 && <section className="detail-panel"><h2>Fund an appeal</h2><p>Kleros appeal contributions use Sepolia ETH. Enter the amount you want to contribute. Flurbo simulates the transaction against the pinned proxy before MetaMask asks you to sign.</p>
            <div className="oracle-fields"><label>Contribution in Sepolia ETH<input inputMode="decimal" value={appealEth} onChange={e => setAppealEth(e.target.value)}/></label><label>Ruling to support<select value={ruling} onChange={e => setRuling(Number(e.target.value))}><option value={2}>Yes</option><option value={1}>No</option><option value={0}>Refuse to rule / invalid</option></select></label></div>
            <button className="btn btn-secondary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('appeal', { ruling, amountEth: appealEth }))}>Review appeal contribution</button></section>}
        </>}
      </div><aside className="oracle-side">
        {snapshot && <section className="detail-panel detail-trade" aria-label="Trade this market"><h2>{snapshot.resolved ? 'Collect shares' : 'Trade this question'}</h2>
          {summary && summary.marketNow < snapshot.closesAt && !snapshot.resolved && <div className="detail-holdings detail-quotes"><div><span>Yes</span><strong>{summary.prices.yes === null ? 'View quote' : `${ausd(summary.prices.yes)} AUSD`}</strong></div><div><span>No</span><strong>{summary.prices.no === null ? 'View quote' : `${ausd(summary.prices.no)} AUSD`}</strong></div><p className="market-caption">Price for one share, test AUSD. Review the exact quote before confirming.</p></div>}
          <div className="oracle-fields"><label>Side<select value={side} onChange={e => setSide(e.target.value as typeof side)}><option value="yes">Yes</option><option value="no">No</option></select></label>
            <label>Shares<input inputMode="decimal" value={shares} onChange={e => setShares(e.target.value)}/></label>
            <label>Second question<select value={extra1} onChange={e => { setExtra1(e.target.value); setExtra2(''); }}><option value="">None</option>{others.map(m => <option key={m.id} value={m.id}>{m.question}</option>)}</select></label>
            {extra1 && <label>Second answer<select value={extra1Side} onChange={e => setExtra1Side(e.target.value as 'yes' | 'no')}><option value="yes">Yes</option><option value="no">No</option></select></label>}
            {extra1 && <label>Third question<select value={extra2} onChange={e => setExtra2(e.target.value)}><option value="">None</option>{others.filter(m => m.id !== extra1).map(m => <option key={m.id} value={m.id}>{m.question}</option>)}</select></label>}
            {extra2 && <label>Third answer<select value={extra2Side} onChange={e => setExtra2Side(e.target.value as 'yes' | 'no')}><option value="yes">Yes</option><option value="no">No</option></select></label>}</div>
          <p className="market-caption">{claim.length > 1 ? 'Every selected outcome must occur.' : 'Single question outcome.'} {position === null ? 'Connect your wallet to see selected shares.' : `Selected shares held: ${ausd(position)}.`}</p>
          {snapshot.resolved ? <button className="btn btn-primary" disabled={!owner || busy || !!pending} onClick={() => run(() => prepare('redeem', { side, quantity: shares, claim }))}>Review redemption</button>
            : <div className="cluster"><button className="btn btn-secondary" disabled={!owner || busy || !!pending || snapshot.marketNow >= snapshot.closesAt} onClick={() => run(() => prepare('approve', { side, quantity: shares, claim }))}>Review AUSD approval</button>
                <button className="btn btn-primary" disabled={!owner || busy || !!pending || snapshot.marketNow >= snapshot.closesAt} onClick={() => run(() => prepare('buy', { side, quantity: shares, claim }))}>Review purchase</button>
                <button className="btn btn-secondary" disabled={!owner || busy || !!pending || snapshot.marketNow >= snapshot.closesAt} onClick={() => run(() => prepare('sell', { side, quantity: shares, claim }))}>Review sale</button></div>}
          <p className="market-caption">Test assets only. Every purchase has a fresh pool quote and a maximum cost. Combinations include up to three outcomes from this pool.</p></section>}

        <section className="detail-panel"><h2>Your wallet</h2><p>Connect MetaMask to your Flurbo account. This wallet signs Sepolia bonds and Monad trades.</p>
          {owner && <p className="mono oracle-address">{owner}</p>}
          <div className="cluster"><button className="btn btn-secondary" disabled={busy} onClick={() => run(() => connect())}>{owner ? 'Switch wallet' : 'Connect MetaMask'}</button></div>
          {wallets.length > 1 && <select aria-label="MetaMask provider" onChange={e => { setProvider(wallets[Number(e.target.value)]?.provider || null); setOwner(''); setPlan(null); }}>{wallets.map((w, i) => <option key={i} value={i}>{w.name} {i + 1}</option>)}</select>}
          {snapshot?.user && <dl className="oracle-facts"><div><dt>Test AUSD</dt><dd>{ausd(snapshot.user.cashAtoms)}</dd></div><div><dt>Yes shares</dt><dd>{ausd(snapshot.user.yesShares)}</dd></div><div><dt>No shares</dt><dd>{ausd(snapshot.user.noShares)}</dd></div><div><dt>Credited Reality ETH</dt><dd>{eth(snapshot.user.creditedEthWei)}</dd></div></dl>}
          {snapshot?.user && !zero(snapshot.user.creditedEthWei) && <button className="btn btn-secondary" disabled={busy || !!pending} onClick={() => run(() => prepare('withdraw'))}>Review ETH withdrawal</button>}
        </section>

        {plan && <section className="detail-panel oracle-review" aria-label="Transaction review"><h2>Review transaction</h2><p>{plan.reason}</p>
          <dl className="oracle-facts"><div><dt>Network</dt><dd>{chainName(plan.transaction.chainId)}</dd></div>
            <div><dt>To</dt><dd className="mono oracle-address">{plan.transaction.to}</dd></div>
            <div><dt>Native {plan.transaction.chainId === 11155111 ? 'ETH' : 'MON'}</dt><dd>{eth(BigInt(plan.transaction.value).toString())}</dd></div></dl>
          <div className="cluster"><button className="btn btn-primary" disabled={busy} onClick={() => run(confirm)}>Confirm in MetaMask</button>
            <button className="btn btn-secondary" disabled={busy} onClick={() => setPlan(null)}>Cancel review</button></div></section>}

        {activePending && <section className="detail-panel"><h2>Transaction pending</h2><p className="mono oracle-address">{activePending.hash}</p><p>Check the receipt before preparing another action.</p>
          <button className="btn btn-secondary" disabled={!provider || busy} onClick={() => run(checkPending)}>Check status</button></section>}
        {pending && pending.market !== id && <p className="state-inline">A transaction for another oracle market is pending. Return there to check it.</p>}
      </aside></div>
      <section className="detail-panel oracle-source"><ShieldCheck size={20}/><div><h2>How this settles</h2><p>Reality takes bonded answers on Sepolia. Kleros can arbitrate a disputed answer. A dedicated relay reports a final result to this Monad testnet pool. The pool delivers payouts after every question is final or void.</p>
        {snapshot && <p className="market-caption">Reality question {snapshot.questionId}. Flurbo pool {snapshot.pool}.</p>}</div></section>
    </>}
  </main>;
}

