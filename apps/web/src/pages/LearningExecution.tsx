import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/context';
import { discoverWallets, type BrowserWallet } from '../auth/wallet-choice';
import { checkLearningReceipt, connectOperator, LearningError, pendingKey, readPending, submitLearning,
  type Pending, type Provider, type Review } from '../learning/execution';
import { learningDeployment } from '../../shared/learning-contracts.mjs';

export default function LearningExecution({ review, onInvalidate, onConfirmed }: {
  review: Review | null; onInvalidate(): void; onConfirmed(approval: boolean): void;
}) {
  const { controller } = useAuth();
  const [wallets, setWallets] = useState<BrowserWallet[]>([]);
  const [selected, setSelected] = useState(0);
  const [connected, setConnected] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [hashInput, setHashInput] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const provider = useRef<Provider | null>(null);
  const live = useRef(true), operating = useRef(false), generation = useRef(0);
  const removeListeners = useRef(() => {});
  const currentReview = useRef(review); currentReview.current = review;
  const invalidate = useRef(onInvalidate); invalidate.current = onInvalidate;
  const completed = useRef(onConfirmed); completed.current = onConfirmed;
  const message = (reason: unknown) => reason instanceof LearningError ? reason.message : 'Wallet check failed. Verify the selected account and public Monad testnet connection.';
  function save(value: Pending | null) {
    try {
      if (value) window.localStorage.setItem(pendingKey, JSON.stringify(value)); else window.localStorage.removeItem(pendingKey);
    } catch {
      if (live.current) { setStorageError(true); if (value?.hash) setPending(value); }
      throw new LearningError('Transaction tracking could not be saved. Keep any displayed hash and check wallet activity before retrying.');
    }
    if (live.current) { setPending(value); setStorageError(false); setAcknowledged(false); }
  }
  useEffect(() => {
    live.current = true;
    const restore = () => {
      try { setPending(readPending(window.localStorage)); setStorageError(false); }
      catch { setStorageError(true); setNotice('Saved transaction tracking could not be read. Check wallet activity before repairing browser storage.'); }
    };
    restore(); window.addEventListener('storage', restore);
    const stop = discoverWallets(wallet => setWallets(list => list.some(item => item.provider === wallet.provider) ? list : [...list, wallet].slice(0, 10)));
    return () => { live.current = false; ++generation.current; stop(); removeListeners.current(); window.removeEventListener('storage', restore); };
  }, []);
  async function connect() {
    if (operating.current) return;
    const chosen = wallets[selected]?.provider as Provider | undefined;
    if (!chosen) { setNotice('Open Flurbo in Firefox with MetaMask, then reload.'); return; }
    operating.current = true; setBusy(true);
    try {
      await connectOperator(chosen);
      if (!live.current) return;
      removeListeners.current(); provider.current = chosen; ++generation.current;
      const changed = () => { ++generation.current; setConnected(false); invalidate.current(); setNotice('Wallet account or network changed. Reconnect before reviewing. Any open wallet prompt must be handled in your wallet.'); };
      for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) chosen.on?.(event, changed);
      removeListeners.current = () => { for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) chosen.removeListener?.(event, changed); };
      setConnected(true); setNotice('Deployer connected on public Monad testnet. Every transaction requires a separate confirmation.');
    } catch (reason) { if (live.current) setNotice(message(reason)); }
    finally { operating.current = false; if (live.current) setBusy(false); }
  }
  async function authorize() {
    const response = await fetch('/api/learning/pool', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(25_000) });
    if (!response.ok) throw new LearningError('Operator session could not be verified. Sign in again before submitting.');
    const status = await response.json();
    if (!status.operator || status.pool !== learningDeployment.pool || !status.open || !status.covered) throw new LearningError('Operator access or pool readiness changed. Refresh the review.');
  }
  async function submit() {
    if (operating.current || !review || !provider.current || !connected || pending || storageError) return;
    if (!navigator.locks) { setNotice('This browser cannot protect concurrent wallet submissions. Use a browser with Web Locks support.'); return; }
    operating.current = true; setBusy(true);
    const chosen = provider.current, expectedGeneration = generation.current;
    const account = controller.getSnapshot().address;
    try {
      await navigator.locks.request('flurbo-learning-submit', { ifAvailable: true }, async lock => {
        if (!lock || readPending(window.localStorage)) throw new LearningError('A learning transaction is already open. Check its confirmation first.');
        setNotice('Checking wallet state and simulating the exact transaction...');
        await submitLearning(chosen, review, { authorize, save,
          current: () => live.current && currentReview.current === review && generation.current === expectedGeneration && controller.getSnapshot().address === account });
        if (live.current) { invalidate.current(); setNotice('Transaction submitted. Waiting for two canonical confirmations and the matching contract event.'); }
      });
    } catch (reason) { if (live.current) { invalidate.current(); setNotice(message(reason)); } }
    finally { operating.current = false; if (live.current) setBusy(false); }
  }
  async function check() {
    if (operating.current || !provider.current || !connected) return;
    operating.current = true; setBusy(true);
    try {
      const saved = readPending(window.localStorage);
      if (!saved) return;
      const result = await checkLearningReceipt(provider.current, saved);
      if (!live.current) return;
      const current = readPending(window.localStorage);
      if (current?.hash !== saved.hash || current.startedAt !== saved.startedAt || current.nonce !== saved.nonce) return;
      if (result === 'confirmed' || result === 'reverted') {
        save(null); invalidate.current();
        setNotice(result === 'reverted' ? 'Transaction reverted. No successful action was confirmed. Prepare a fresh review.' :
          saved.review.action === 'approval_required' ? 'Approval confirmed. Preparing a fresh proposal for your separate update confirmation.' : 'Pricing update confirmed. The saved calldata, proposal hash and funding event match.');
        if (result === 'confirmed') completed.current(saved.review.action === 'approval_required');
      } else setNotice(result === 'confirming' ? 'Mined. Waiting for a second canonical confirmation.' : 'Transaction is pending or not yet visible. It will not be submitted again automatically.');
    } catch (reason) { if (live.current) setNotice(message(reason)); }
    finally { operating.current = false; if (live.current) setBusy(false); }
  }
  const checkRef = useRef(check); checkRef.current = check;
  useEffect(() => {
    if (!pending?.hash || !connected) return;
    const started = Date.now();
    const timer = setInterval(() => { if (Date.now() - started < 120_000) void checkRef.current(); else clearInterval(timer); }, 10_000);
    return () => clearInterval(timer);
  }, [pending?.hash, connected]);
  function attachHash() {
    try {
      const saved = readPending(window.localStorage);
      if (!saved || !/^0x[0-9a-f]{64}$/i.test(hashInput.trim())) throw new LearningError('Paste a transaction hash from this wallet attempt.');
      save({ ...saved, hash: hashInput.trim().toLowerCase() }); setHashInput('');
      setNotice('Hash attached. Confirmation checks will verify its sender, nonce, exact action and event.');
    } catch (reason) { setNotice(message(reason)); }
  }
  return <section aria-label="Learning operator wallet" className="learning-execution">
    <h3>Confirm with your deployer wallet</h3>
    <p className="auth-help">Use {learningDeployment.updater}. Mera grants access to these controls; MetaMask signs the transactions.</p>
    <label htmlFor="learning-wallet">MetaMask wallet</label>
    <select id="learning-wallet" value={selected} disabled={busy} onChange={event => { setSelected(Number(event.target.value)); setConnected(false); ++generation.current; removeListeners.current(); invalidate.current(); }}>
      {!wallets.length && <option>MetaMask not detected</option>}
      {wallets.map((wallet, index) => <option value={index} key={index}>{wallet.name}</option>)}
    </select>
    <button className="button button-dark" disabled={busy || !wallets.length || connected} onClick={() => void connect()}>{connected ? 'Deployer connected' : 'Connect deployer wallet'}</button>
    {review && !pending && <button className="button button-dark" disabled={busy || !connected || storageError || Date.now() >= review.expiresAt * 1000} onClick={() => void submit()}>
      {busy ? 'Checking wallet...' : review.action === 'approval_required' ? 'Confirm AUSD approval in wallet' : 'Confirm pricing update in wallet'}
    </button>}
    {notice && <p role="status">{notice}</p>}
    {pending && <div>
      <p>{pending.hash ? <>Tracking <a href={`https://testnet.monadscan.com/tx/${pending.hash}`} target="_blank" rel="noreferrer"><code>{pending.hash}</code></a></> : 'Wallet confirmation is open or its submission result is unknown. Check wallet activity before doing anything else.'}</p>
      <button className="button button-dark" disabled={busy || !connected || !pending.hash} onClick={() => void check()}>Check confirmation</button>
      <details><summary>Recover a transaction or replacement</summary>
        <label htmlFor="learning-tx-hash">Transaction hash from wallet activity</label>
        <input id="learning-tx-hash" value={hashInput} onChange={event => setHashInput(event.target.value)} placeholder="0x..." disabled={busy}/>
        <button className="button button-dark" onClick={attachHash} disabled={busy}>Attach hash</button>
        <label><input type="checkbox" checked={acknowledged} disabled={busy} onChange={event => setAcknowledged(event.target.checked)}/> I checked wallet activity and the nonce. This attempt is cancelled, replaced or otherwise resolved.</label>
        <button className="button" disabled={busy || !acknowledged} onClick={() => { try { save(null); invalidate.current(); setNotice('Tracking cleared at your request. No transaction was cancelled or submitted. Prepare a fresh review.'); } catch (reason) { setNotice(message(reason)); } }}>Clear resolved tracking</button>
      </details>
    </div>}
  </section>;
}
