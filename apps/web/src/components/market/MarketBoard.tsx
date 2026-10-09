import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { m } from 'framer-motion';
import { useLocation } from 'wouter';
import { ArrowDownUp, Inbox, Info, RefreshCw, Search } from 'lucide-react';
import MarketTile from './MarketTile';
import CategoryNav from './CategoryNav';
import LinkedRail from './LinkedRail';
import Pager from '../ui/Pager';
import { boardCapacity, paginate } from '../../board-layout';
import { filterBoardRows, type BoardRow } from '../../market-board-rows';
import { visibleCategories, writeBoardQuery, type BoardQuery, type BoardSort, type BoardStatus, type CategorySlug } from '../../market-categories';
import { shortcutFor } from '../../shortcuts';
import { compactRelative } from '../../format';

const SLIDE = { type: 'spring', stiffness: 560, damping: 42, mass: 0.6 } as const;
const FOOT_H = 64, FOOT_H_COMPACT = 56, GRID_PAD = 12, GRID_PAD_COMPACT = 4, BOTTOM_PAD = 8;
const STATUSES: [BoardStatus, string][] = [['open', 'Open'], ['closed', 'Closed'], ['settled', 'Settled'], ['all', 'All']];
const SORTS: [BoardSort, string][] = [['closing', 'Closing soon'], ['name', 'A to Z']];
const LEGEND = 'Prices are the cost of one share in test AUSD, including price impact. A correct share pays 1.000. Prices are not probabilities.';

function PressedGroup<T extends string>({ label, options, value, onChange, disabled = false, className = '' }: { label: string; options: [T, string][]; value: T; onChange(value: T): void; disabled?: boolean; className?: string }) {
  const id = useId();
  return <div className={`segmented ${className}`.trim()} role="group" aria-label={label}>
    {options.map(([option, text]) => <button key={option} type="button" aria-pressed={option === value} disabled={disabled} onClick={() => { if (option !== value) onChange(option); }}>
      {option === value && <m.span className="seg-ink" layoutId={`pressed-${id}`} transition={SLIDE} aria-hidden="true" />}<span>{text}</span>
    </button>)}
  </div>;
}

export type BoardProps = {
  rows: BoardRow[]; query: BoardQuery; onQuery(next: Partial<BoardQuery>): void; now: number;
  watchlist: ReadonlySet<string> | null; onWatch(key: string): void; deltas: ReadonlyMap<string, bigint>; stableOrder: readonly string[] | null;
  loading: boolean; failed: boolean; pendingPools: number; updatedAt: number | null; onRefresh(): void; unavailable: boolean;
};

export default function MarketBoard({ rows, query, onQuery, now, watchlist, onWatch, deltas, stableOrder, loading, failed, pendingPools, updatedAt, onRefresh, unavailable }: BoardProps) {
  const [, navigate] = useLocation();
  const region = useRef<HTMLElement>(null), chromeRefs = useRef<(HTMLElement | null)[]>([]), search = useRef<HTMLInputElement>(null);
  const [capacity, setCapacity] = useState({ columns: 4, rows: 4, perPage: 16, fits: true, compact: false });
  const [group, setGroup] = useState<string | null>(null);
  const [direction, setDirection] = useState(1);

  // Capacity comes from the space left after the header and board chrome, measured on resize only.
  useLayoutEffect(() => {
    const measure = () => {
      const node = region.current;
      if (!node) return;
      const compact = window.innerWidth < 640;
      const header = document.querySelector<HTMLElement>('.site-header')?.offsetHeight ?? 64;
      const chrome = header + chromeRefs.current.reduce((sum, el) => sum + (el?.offsetHeight ?? 0), 0) + (compact ? GRID_PAD_COMPACT + FOOT_H_COMPACT : GRID_PAD + FOOT_H) + BOTTOM_PAD;
      const next = boardCapacity({ width: node.clientWidth, height: window.innerHeight, compact, chrome });
      setCapacity((old) => old.columns === next.columns && old.rows === next.rows && old.fits === next.fits && old.compact === compact ? old : { ...next, compact });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (region.current) observer.observe(region.current);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [failed]);

  const watchCount = watchlist?.size ?? 0;
  const categories = useMemo(() => visibleCategories(rows, watchCount), [rows, watchCount]);
  const category: CategorySlug = categories.some((c) => c.slug === query.category) ? query.category : 'all';
  const filtered = useMemo(() => {
    const list = filterBoardRows(rows, { ...query, category }, watchlist ?? new Set());
    if (!stableOrder) return list;
    const rank = new Map(stableOrder.map((key, i) => [key, i]));
    return [...list].sort((a, b) => (rank.get(a.key) ?? Infinity) - (rank.get(b.key) ?? Infinity));
  }, [rows, query, category, watchlist, stableOrder]);
  const paged = capacity.fits ? paginate(filtered, capacity.perPage, query.page) : { items: filtered, page: 1, pageCount: 1 };
  const pageKey = `${category}|${query.status}|${query.sort}|${query.q}|${paged.page}|${capacity.columns}x${capacity.rows}`;

  const setPage = useCallback((page: number) => { setDirection(page >= paged.page ? 1 : -1); onQuery({ page }); }, [onQuery, paged.page]);

  // Shortcuts move focus and pages. Opening a market with an answer only navigates; nothing is bought here.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = shortcutFor(event, event.target as HTMLElement | null, 'board', !!document.querySelector('dialog[open]'));
      if (!action || action === 'help' || action === 'open') return;
      const links = [...(region.current?.querySelectorAll<HTMLAnchorElement>('.market-card .tile-q a') ?? [])];
      const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.market-card');
      const index = focused ? links.findIndex((link) => focused.contains(link)) : -1;
      const row = index >= 0 ? paged.items[index] : null;
      if (action === 'search') search.current?.focus();
      else if (action === 'next' || action === 'prev') links[index < 0 ? 0 : (index + (action === 'next' ? 1 : -1) + links.length) % links.length]?.focus();
      else if (action === 'pageNext' && paged.page < paged.pageCount) setPage(paged.page + 1);
      else if (action === 'pagePrev' && paged.page > 1) setPage(paged.page - 1);
      else if ((action === 'yes' || action === 'no') && row && row.status === 'Open') navigate(row.href(action === 'yes'));
      else if (action === 'watch' && row && watchlist) onWatch(row.key);
      else return;
      event.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [paged, setPage, navigate, onWatch, watchlist]);

  const hrefFor = (slug: CategorySlug) => '/markets' + writeBoardQuery({ ...query, category: slug, page: 1 });
  const first = filtered.length ? (paged.page - 1) * capacity.perPage + 1 : 0, last = capacity.fits ? Math.min(filtered.length, paged.page * capacity.perPage) : filtered.length;
  const grid = capacity.fits ? { gridTemplateColumns: `repeat(${capacity.columns}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${capacity.rows}, minmax(0, 1fr))` } : undefined;
  const emptyTitle = loading ? 'Loading questions...' : unavailable ? 'Markets are temporarily unavailable' : query.q ? 'No matching questions' : category === 'watchlist' ? 'Your watchlist is empty' : query.status === 'open' ? 'No open markets right now' : 'No markets to show';
  const emptyText = loading ? 'Questions appear as their prices are checked.' : query.q ? 'Try a different search or show all markets.' : category === 'watchlist' ? 'Use the star on any market to keep it here.' : query.status === 'open' ? 'You can view closed markets and follow existing positions in Portfolio. New opening dates have not been announced.' : 'Try another status or search. New questions will appear here when they are published.';

  return (
    <main id="main" tabIndex={-1} className={`board-page${capacity.fits ? '' : ' board-list'}${capacity.compact ? ' board-compact' : ''}`}>
      <h1 className="sr-only">Markets</h1>
      <div className="board-subnav" ref={(el) => { chromeRefs.current[0] = el; }}>
        <CategoryNav categories={categories} active={category} hrefFor={hrefFor} onSelect={(slug) => onQuery({ category: slug })} />
        <button type="button" className="board-shortcuts" onClick={() => window.dispatchEvent(new Event('flurbo:shortcuts'))}><kbd>?</kbd><span>Shortcuts</span></button>
      </div>
      <div className="board-toolbar" role="search" ref={(el) => { chromeRefs.current[1] = el; }}>
        <label className="board-search"><Search aria-hidden="true" strokeWidth={1.75} /><span className="sr-only">Search markets</span>
          <input ref={search} placeholder="Find a market" value={query.q} autoComplete="off" spellCheck={false} onChange={(event) => onQuery({ q: event.target.value })} /><kbd aria-hidden="true">/</kbd></label>
        <PressedGroup label="Market status" options={STATUSES} value={query.status} onChange={(status) => onQuery({ status })} disabled={category === 'watchlist'} className="board-status" />
        <PressedGroup label="Sort" options={SORTS} value={query.sort} onChange={(sort) => onQuery({ sort })} className="board-sort" />
        <button type="button" className="btn btn-secondary btn-icon board-sort-toggle" aria-label={`Sort: ${query.sort === 'name' ? 'A to Z' : 'Closing soon'}`} onClick={() => onQuery({ sort: query.sort === 'name' ? 'closing' : 'name' })}><ArrowDownUp aria-hidden="true" strokeWidth={1.75} /></button>
        <span className="board-fresh">{loading ? <span role="status">{pendingPools > 0 ? `Loading ${pendingPools} more ${pendingPools === 1 ? 'collection' : 'collections'}` : 'Updating prices'}</span> : updatedAt ? <>Updated {compactRelative(Math.min(updatedAt / 1000, now), now)}</> : null}</span>
        <button type="button" className="btn btn-secondary board-refresh" disabled={loading} onClick={onRefresh}><RefreshCw aria-hidden="true" strokeWidth={1.75} /><span className="board-refresh-label">{loading ? 'Updating prices...' : 'Refresh prices'}</span></button>
        <details className="board-legend-more"><summary aria-label="About prices"><Info aria-hidden="true" strokeWidth={1.75} /></summary><p>{LEGEND}</p></details>
      </div>
      <div className="board-legend" ref={(el) => { chromeRefs.current[2] = el; }}>
        <p>{LEGEND}</p>
      </div>
      {failed && <p role="alert" className="state-inline error board-alert" ref={(el) => { chromeRefs.current[3] = el; }}>Some markets could not be refreshed. Other markets are still available. Use Refresh prices to retry.</p>}
      <section className="board-region" aria-label="Markets" data-market-count={rows.length} ref={region}>
        <p className="sr-only" aria-live="polite">{filtered.length} markets{capacity.fits && paged.pageCount > 1 ? `, page ${paged.page} of ${paged.pageCount}` : ''}</p>
        {paged.items.length > 0
          ? <m.div key={pageKey} className="board-grid" style={grid} initial={{ opacity: 0, x: 10 * direction }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}>
              {paged.items.map((row) => <MarketTile key={row.key} row={row} now={now} delta={deltas.get(row.key) ?? null} watched={!!watchlist?.has(row.key)} onWatch={watchlist ? onWatch : null} onFocusGroup={setGroup} />)}
            </m.div>
          : loading && !rows.length
            ? <div className="board-grid" style={grid} aria-hidden="true">{Array.from({ length: Math.min(capacity.perPage || 8, 16) }, (_, i) => <div className="market-card market-card-skeleton" key={i}><span className="skeleton skeleton-line" style={{ width: '40%' }} /><span className="skeleton skeleton-line" style={{ width: `${82 - (i % 3) * 12}%` }} /><span className="skeleton" style={{ height: 34 }} /></div>)}</div>
            : <div className="state-block board-empty"><Inbox aria-hidden="true" strokeWidth={1.75} /><h2>{emptyTitle}</h2><p>{emptyText}</p>
                {!loading && <button type="button" className="btn btn-secondary" onClick={() => onQuery({ q: '', status: 'all', category: 'all' })}>Show all markets</button>}</div>}
        {!capacity.compact && <LinkedRail host={region} group={group} version={pageKey} />}
      </section>
      {capacity.fits && <div className="board-foot">
        <span className="board-count">{filtered.length ? `${first} to ${last} of ${filtered.length} markets` : ''}</span>
        <Pager page={paged.page} pageCount={paged.pageCount} onPage={setPage} label="Pages" />
      </div>}
    </main>
  );
}
