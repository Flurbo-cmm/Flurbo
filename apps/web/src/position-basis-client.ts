import { useEffect, useState } from 'react';
import { hybridPoolRequest } from './hybrid-portfolio.ts';
import { hybridNamespace } from './portfolio-groups.ts';
import { accountActivity, type TradeActivity } from './portfolio-performance.ts';
import type { HistoryRead } from './portfolio-loader.ts';

type Basis = { status: 'idle' | 'loading' | 'ready' | 'failed'; trades: TradeActivity[] };
const MAX_AGE_MS = 60_000;
const saved = new Map<string, { at: number; trades: TradeActivity[] }>();

// The wallet's recorded trades in one pool, read once when the member starts a sale and reused for a minute.
export function useCostBasis(pool: string, owner: string | null, enabled: boolean): Basis {
  const [basis, setBasis] = useState<Basis>({ status: 'idle', trades: [] });
  useEffect(() => {
    if (!enabled || !owner) { setBasis({ status: 'idle', trades: [] }); return; }
    const key = `${pool.toLowerCase()}:${owner.toLowerCase()}`, hit = saved.get(key);
    if (hit && Date.now() - hit.at < MAX_AGE_MS) { setBasis({ status: 'ready', trades: hit.trades }); return; }
    const controller = new AbortController();
    setBasis({ status: 'loading', trades: [] });
    const namespace = hybridNamespace(pool);
    void hybridPoolRequest<HistoryRead>('history', {}, namespace, controller.signal).then(history => {
      if (controller.signal.aborted) return;
      const trades = accountActivity(namespace, pool, history.logs, [owner]);
      saved.set(key, { at: Date.now(), trades });
      setBasis({ status: 'ready', trades });
    }).catch(() => { if (!controller.signal.aborted) setBasis({ status: 'failed', trades: [] }); });
    return () => controller.abort();
  }, [pool, owner, enabled]);
  return basis;
}
