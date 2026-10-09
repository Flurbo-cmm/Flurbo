import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'wouter';
import { ArrowLeft, ArrowUpRight, Star } from 'lucide-react';
import { useAuth } from '../../auth/context';
import Tabs from '../ui/Tabs';
import Price from '../ui/Price';
import { readWatchlist, toggleWatchlist } from '../../watchlist';
import { exactTime, relativeTime } from '../../format';
import { shortcutFor } from '../../shortcuts';

export type MarketTab = 'linked' | 'timeline' | 'proof';
const BOARD_URL_KEY = 'flurbo.board-url';
const boardUrl = () => { try { return sessionStorage.getItem(BOARD_URL_KEY) || '/markets'; } catch { return '/markets'; } };

// One page anatomy for every market kind: question and price pair first, chart and tabs on the left, the ticket on the
// right. The page supplies every panel; the shell only arranges them.
export default function MarketShell({ kind, question, lead, status, closes, results, prices, watchKey, alert, chart, linked, linkedCount = 0, timeline, proof, defaultTab, ticket, className = '' }: {
  kind: string; question: string; lead?: ReactNode; status: ReactNode; closes: { at: number; closed: boolean }; results: number;
  prices: { yes: string | null; no: string | null } | null; watchKey: string | null; alert?: ReactNode; chart: ReactNode;
  linked?: ReactNode; linkedCount?: number; timeline: ReactNode; proof: ReactNode; defaultTab: MarketTab; ticket: ReactNode; className?: string;
}) {
  const { state: auth } = useAuth();
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now() / 1000), 30_000); return () => clearInterval(timer); }, []);
  const [tab, setTab] = useState<MarketTab>(() => {
    const requested = new URLSearchParams(window.location.search).get('tab');
    return requested === 'linked' && linked ? 'linked' : requested === 'timeline' || requested === 'proof' ? requested : defaultTab;
  });
  const chosen = useRef(new URLSearchParams(window.location.search).has('tab'));
  // Until the member picks a tab, the default follows the market as it changes (for example when trading closes).
  useEffect(() => { if (!chosen.current) setTab(defaultTab === 'linked' && !linked ? 'proof' : defaultTab); }, [defaultTab, !!linked]);
  const selectTab = (next: MarketTab) => {
    chosen.current = true; setTab(next);
    const url = new URL(window.location.href); url.searchParams.set('tab', next);
    window.history.replaceState(window.history.state, '', url);
  };
  const [watched, setWatched] = useState(() => !!watchKey && !!auth.address && readWatchlist(auth.address).has(watchKey));
  // The ticket column stays in view only while it fits; a taller column scrolls with the page.
  const [stick, setStick] = useState(false);
  const observer = useRef<ResizeObserver | null>(null), recheck = useRef<() => void>(() => {});
  const sidebar = useCallback((node: HTMLElement | null) => {
    observer.current?.disconnect(); observer.current = null;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const check = () => setStick(window.innerWidth >= 1024 && node.scrollHeight < window.innerHeight - 96); recheck.current = check;
    observer.current = new ResizeObserver(check); observer.current.observe(node); check();
  }, []);
  useEffect(() => { const onResize = () => recheck.current(); window.addEventListener('resize', onResize); return () => { window.removeEventListener('resize', onResize); observer.current?.disconnect(); }; }, []);
  // Market keys choose options in the ticket or refresh its price. None of them reviews, confirms or sends anything.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = shortcutFor(event, event.target as HTMLElement | null, 'market', !!document.querySelector('dialog[open]'));
      const aside = document.querySelector<HTMLElement>('.market-sidebar');
      if (!action || action === 'help' || !aside) return;
      const option = (group: string, label: string) => [...aside.querySelectorAll<HTMLElement>('[role="radiogroup"]')]
        .find((node) => document.getElementById(node.getAttribute('aria-labelledby') ?? '')?.textContent === group)
        ?.querySelector<HTMLButtonElement>(`[role="radio"]:not(:disabled)[data-value="${label}"]`);
      const target = action === 'yes' ? option('Your answer', 'yes') : action === 'no' ? option('Your answer', 'no')
        : action === 'buy' ? option('Buy or sell', 'buy') : action === 'sell' ? option('Buy or sell', 'sell')
        : action === 'refresh' ? [...aside.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')].find((button) => button.textContent?.trim() === 'Refresh price') : null;
      if (!target) return;
      event.preventDefault();
      target.click();
      if (action !== 'refresh') target.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const tabs = [
    ...(linked ? [{ id: 'linked' as const, label: 'Linked', count: linkedCount > 1 ? linkedCount - 1 : undefined, panel: linked }] : []),
    { id: 'timeline' as const, label: 'Timeline', panel: timeline },
    { id: 'proof' as const, label: 'Proof', panel: proof },
  ];
  return (
    <main id="main" tabIndex={-1} className={`market-page ${className}`.trim()}>
      <nav className="market-topbar" aria-label="Breadcrumb">
        <Link href={boardUrl()} className="link-back"><ArrowLeft aria-hidden="true" strokeWidth={1.75} />All markets</Link>
        <div className="market-topbar-end">
          <Link href="/fund" className="text-link">Get test funds <ArrowUpRight aria-hidden="true" strokeWidth={1.75} /></Link>
          {watchKey && auth.address && <button type="button" className="market-watch" aria-pressed={watched} onClick={() => setWatched(toggleWatchlist(auth.address!, watchKey).has(watchKey))}>
            <Star aria-hidden="true" strokeWidth={1.75} />{watched ? 'Watching' : 'Watch'}</button>}
        </div>
      </nav>
      <header className="market-head">
        <div className="market-head-main">
          <span className="chip">{kind}</span>
          <h1 title={question}>{question}</h1>
          {lead && <p className="lead">{lead}</p>}
          <div className="market-meta">
            {status}
            <span>{closes.closed ? 'Trading closed' : 'Trading closes'} <time dateTime={new Date(closes.at * 1000).toISOString()} title={exactTime(closes.at)}>{relativeTime(closes.at, now)}</time></span>
            <span>Results expected <time dateTime={new Date(results * 1000).toISOString()} title={exactTime(results)}>{relativeTime(results, now)}</time></span>
          </div>
        </div>
        {prices && <div className="market-price-pair" aria-label="Buy one share">
          <div><span>Yes</span><Price atoms={prices.yes} fallback="Closed" className="figure-lg" /></div>
          <div><span>No</span><Price atoms={prices.no} fallback="Closed" className="figure-lg" /></div>
          <p>Test AUSD per share. Not a probability.</p>
        </div>}
      </header>
      {alert}
      <div className="market-columns">
        <div className="market-primary">
          {chart}
          <Tabs label="Market details" tabs={tabs} value={tabs.some((t) => t.id === tab) ? tab : tabs[0].id} onChange={selectTab} className="market-tabs" />
        </div>
        <aside ref={sidebar} className={`market-sidebar${stick ? ' is-sticky' : ''}`} aria-label="Trade and position">{ticket}</aside>
      </div>
    </main>
  );
}
