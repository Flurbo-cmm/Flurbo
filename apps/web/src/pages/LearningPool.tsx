import { useEffect, useRef, useState } from 'react';
import LearningExecution from './LearningExecution';
import type { Review } from '../learning/execution';

type Pool = { schema: string; pool: string; updater: string; block: string; timestamp: string; closesAt: number;
  revision: string; updates: string; collateralAtoms: string; reserveAtoms: string; covered: boolean;
  open: boolean; modelReady: boolean; operator: boolean };
const amount = (value: string) => (Number(value) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 });

export default function LearningPool() {
  const [pool, setPool] = useState<Pool | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [clock, setClock] = useState(Date.now());
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    const tick = setInterval(() => setClock(Date.now()), 1000);
    return () => { clearInterval(tick); active.current?.abort(); active.current = null; };
  }, []);
  async function load(proposal = false) {
    active.current?.abort(); const controller = new AbortController(); active.current = controller;
    setBusy(true); setError(''); setReview(null);
    const timeout = setTimeout(() => controller.abort(), 28_000);
    try {
      const response = await fetch(proposal ? '/api/learning/proposal' : '/api/learning/pool', {
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        ...(proposal ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
      });
      if (!response.ok) throw new Error(response.status === 401 ? 'Sign in again to view the experiment.' : response.status === 403 ?
        'This Flurbo account does not have operator access.' : proposal ?
          'Proposal unavailable. Wait 15 seconds and refresh. The pool, funding or model may no longer satisfy the review checks.' :
          'The learning pool could not be read. Try again shortly. Your trading market is separate.');
      const value = await response.json();
      if (proposal ? value.schema !== 'flurbo.learning-review.v1' || !Number.isFinite(value.expiresAt) : value.schema !== 'flurbo.learning-pool.v1') throw new Error('Unrecognized learning response.');
      if (active.current === controller) { if (proposal) setReview(value); else setPool(value); }
    } catch (reason) {
      if (active.current === controller) { if (!proposal) setPool(null); setError(controller.signal.aborted ? 'The request timed out. Try again shortly.' : reason instanceof Error ? reason.message : 'Learning experiment unavailable.'); }
    } finally { clearTimeout(timeout); if (active.current === controller) setBusy(false); }
  }
  const expired = review && clock >= review.expiresAt * 1000;
  function download() {
    if (!review || expired) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(review, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'flurbo-unsigned-learning-review.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <details className="workspace-funding learning-comparison">
    <summary>Learning pool <span className="auth-help">Testnet experiment</span></summary>
    <p>A separate eight-event pool for testing funded price updates. Your existing trading market and positions remain in Explore &amp; trade.</p>
    <button className="button button-dark" disabled={busy} onClick={() => void load()}>{busy ? 'Reading testnet...' : pool ? 'Refresh pool status' : 'View pool status'}</button>
    {error && <p role="status">{error}</p>}
    {pool && <>
      <div className="comparison-table"><table><caption>Observed at block {pool.block}</caption><thead><tr><th>Market</th><th>Pool AUSD</th><th>Pricing reserve</th><th>Updates</th></tr></thead>
        <tbody><tr><td>{pool.open ? 'Open' : 'Closed or unfunded'} / {pool.covered ? 'covered' : 'not covered'}</td><td>{amount(pool.collateralAtoms)}</td><td>{amount(pool.reserveAtoms)}</td><td>{pool.updates}</td></tr></tbody></table></div>
      <p className="auth-help">Pool <code>{pool.pool}</code><br/>Checked {new Date(Number(pool.timestamp) * 1000).toLocaleString()}. Refresh for current state. Closes {new Date(pool.closesAt * 1000).toLocaleString()}.</p>
      <p>The Rust fixture learns from one synthetic A AND B observation. C through H remain independent and untrained. There is no live observation feed or automatic repricing.</p>
      {pool.operator ? <>
        <p>Prepare a proposal with at most 1 test AUSD of added funding, then confirm each action separately in your deployer wallet.</p>
        <button className="button button-dark" disabled={busy || !pool.modelReady || !pool.open || !pool.covered} onClick={() => void load(true)}>Prepare synthetic proposal</button>
        {!pool.modelReady && <p role="status">The Rust fixture is starting or unavailable.</p>}
      </> : <p className="auth-help">Proposal preparation is available to the configured Flurbo operator account.</p>}
      {review && <section aria-label="Unsigned learning review">
        <h3>{expired ? 'Review expired' : 'Review the proposed update'}</h3>
        <p>Snapshot block {review.snapshot.blockNumber}, revision {review.snapshot.revision}. {expired ? 'Prepare a fresh proposal before proceeding.' : `Expires ${new Date(review.expiresAt * 1000).toLocaleTimeString()}.`}</p>
        <p>Maximum added funding: <strong>{amount(review.fundingAtoms)} test AUSD</strong>. Bias movement: {amount(review.movementAtoms)} AUSD in cost-function units.</p>
        <p>Example cost for buying one A AND B share: <strong>{amount(review.quoteBeforeAtoms)} → {amount(review.quoteAfterAtoms)} AUSD</strong>. These are quantity quotes, not probabilities.</p>
        <p>{review.updateSimulated ? 'The exact update call passed simulation at this snapshot.' : 'AUSD approval is required. Only the approval call was simulated. After approval, prepare a fresh proposal to simulate the update itself.'}</p>
        <p className="auth-help">The deployer {pool.updater} signs updates. Your Mera login grants access to this review; it does not authorize transactions for the deployer.</p>
        <button className="button button-dark" disabled={!!expired || busy} onClick={download}>Download unsigned review</button>
        <details><summary>Model and snapshot evidence</summary><p>Model SHA-256: <code>{review.modelSha256}</code></p><p>Snapshot SHA-256: <code>{review.snapshotSha256}</code></p><p>Quantization variation bound: {review.quantizationBound}. This is numerical conversion evidence, not a statistical loss guarantee.</p></details>
        <p className="auth-help">{review.notice}</p>
      </section>}
      {pool.operator && <LearningExecution review={review} onInvalidate={() => setReview(null)} onConfirmed={approval => void load(approval)}/>}
    </>}
  </details>;
}
