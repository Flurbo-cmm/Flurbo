import { useEffect, useState } from 'react';
import { loadPortfolio } from './portfolio-loader.ts';
import { hybridPortfolioGroups } from './portfolio-groups.ts';
import type { AccountHolding } from './account-holdings.ts';

type PoolMarket = { pool: string; poolTitle: string; closesAt: number };

// The wallet's positions in one pool, read through the same loader the portfolio uses, so combined positions are found.
export function usePoolHoldings({ market, account, owner, refresh }: { market: PoolMarket | undefined; account: string | null; owner: string; refresh: number }) {
  const [state, setState] = useState<{ rows: AccountHolding[]; complete: boolean; error: string; loading: boolean }>({ rows: [], complete: false, error: '', loading: false });
  const pool = market?.pool ?? '', title = market?.poolTitle ?? '', closesAt = market?.closesAt ?? 0;
  useEffect(() => {
    if (!pool || !account || !owner) { setState({ rows: [], complete: false, error: '', loading: false }); return; }
    const controller = new AbortController();
    const wallet = owner.toLowerCase();
    setState(old => ({ ...old, loading: true, error: '' }));
    void loadPortfolio({ groups: hybridPortfolioGroups([{ pool, poolTitle: title, closesAt }]), account, wallets: [owner], signal: controller.signal,
      publish: (_namespace, read) => {
        if (controller.signal.aborted) return;
        setState({ rows: (read.owners[wallet] ?? []).filter(row => BigInt(row.quantity) > 0n), complete: read.holdingsComplete, error: read.error ?? '', loading: !read.holdingsComplete && !read.error });
      } }).catch(() => { if (!controller.signal.aborted) setState(old => ({ ...old, complete: false, loading: false, error: 'Your positions could not be read.' })); })
      .finally(() => { if (!controller.signal.aborted) setState(old => ({ ...old, loading: false })); });
    return () => controller.abort();
  }, [pool, title, closesAt, account, owner, refresh]);
  return state;
}
