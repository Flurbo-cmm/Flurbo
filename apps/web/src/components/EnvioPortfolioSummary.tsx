import { useEffect, useState } from 'react';
import { amount } from '../portfolio';
import { fetchPortfolioPositions, type EnvioTraderPosition } from '../envio';

type State = { status: 'loading' | 'ready' | 'error'; positions: EnvioTraderPosition[] };

export default function EnvioPortfolioSummary({ pools, traders }: { pools: string[]; traders: string[] }) {
  const [state, setState] = useState<State>({ status: 'loading', positions: [] });
  const [revision, setRevision] = useState(0);
  const poolKey = pools.join(',');
  const traderKey = traders.join(',');
  useEffect(() => {
    if (!pools.length || !traders.length || pools.length > 25 || traders.length > 8) {
      setState({ status: 'error', positions: [] });
      return;
    }
    const controller = new AbortController();
    setState({ status: 'loading', positions: [] });
    void fetchPortfolioPositions(pools, traders, undefined, controller.signal)
      .then(positions => { if (!controller.signal.aborted) setState({ status: 'ready', positions }); })
      .catch(() => { if (!controller.signal.aborted) setState({ status: 'error', positions: [] }); });
    return () => controller.abort();
  // The joined keys capture the wallet and market identities without refetching on each render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poolKey, traderKey, revision]);

  const sum = (field: 'totalCostAtoms' | 'totalProceedsAtoms' | 'totalRedeemedAtoms') =>
    state.positions.reduce((total, position) => total + BigInt(position[field]), 0n);
  return <aside className="portfolio-indexed-summary" aria-label="Envio indexed cash movement">
    <div className="portfolio-section-heading"><h3>Indexed cash movement</h3><span className="chip">Envio</span></div>
    <p>Trades and redemptions for your linked wallets in these markets. Indexing can lag the chain; these totals are cash movement, not profit or current balance.</p>
    {state.status === 'loading' && <p role="status">Loading indexed activity…</p>}
    {state.status === 'error' && <p role="status">Indexed cash movement is unavailable. Your verified portfolio remains available.</p>}
    {state.status === 'ready' && (state.positions.length ? <dl className="portfolio-indexed-totals">
      <div><dt>Spent on buys</dt><dd>{amount(String(sum('totalCostAtoms')))} test AUSD</dd></div>
      <div><dt>Received from sales</dt><dd>{amount(String(sum('totalProceedsAtoms')))} test AUSD</dd></div>
      <div><dt>Collected from redemptions</dt><dd>{amount(String(sum('totalRedeemedAtoms')))} test AUSD</dd></div>
    </dl> : <p>No indexed activity for these linked wallets yet.</p>)}
    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRevision(value => value + 1)}>Refresh indexed activity</button>
  </aside>;
}
