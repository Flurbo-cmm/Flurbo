import { useEffect, useState } from 'react';
import { fetchRecentTrades, type EnvioTrade } from '../envio';

type State = { status: 'loading' | 'ready' | 'error'; trades: EnvioTrade[] };

function units(atoms: string): string {
  try {
    const n = BigInt(atoms);
    const sign = n < 0n ? '-' : '';
    const absolute = n < 0n ? -n : n;
    return `${sign}${absolute / 1_000_000n}.${String(absolute % 1_000_000n).padStart(6, '0')}`;
  } catch { return 'Unavailable'; }
}

export default function EnvioActivity({ pool }: { pool: string }) {
  const [state, setState] = useState<State>({ status: 'loading', trades: [] });
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading', trades: [] });
    void fetchRecentTrades(pool, 5, undefined, controller.signal)
      .then(trades => { if (!controller.signal.aborted) setState({ status: 'ready', trades }); })
      .catch(() => { if (!controller.signal.aborted) setState({ status: 'error', trades: [] }); });
    return () => controller.abort();
  }, [pool, refresh]);

  return <details className="what-if-evidence disclosure">
    <summary>Recent pool activity · Envio</summary>
    <p>Indexed trade history may lag the chain. Current quotes, holdings, and outcomes come from the pool.</p>
    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRefresh(value => value + 1)}>Refresh activity</button>
    {state.status === 'loading' && <p role="status">Loading indexed activity…</p>}
    {state.status === 'error' && <p role="status">Indexed activity is unavailable right now.</p>}
    {state.status === 'ready' && state.trades.length === 0 && <p>No indexed trades for this pool yet.</p>}
    {state.status === 'ready' && state.trades.length > 0 && <ol>
      {state.trades.map(trade => <li key={trade.id}>
        {trade.side === 'REDEEM' ? 'Redeemed' : trade.side === 'SELL' ? 'Sold' : 'Bought'} {units(trade.quantityAtoms)} shares
        {' · '}{units(trade.amountAtoms)} test AUSD
        {' · '}block {trade.blockNumber}
      </li>)}
    </ol>}
  </details>;
}
