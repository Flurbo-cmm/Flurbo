import { memo } from 'react';
import { Link } from 'wouter';
import { Link2, Star } from 'lucide-react';
import Price, { PriceDelta, formatAtoms } from '../ui/Price';
import type { BoardRow } from '../../market-board-rows';
import { CLOSING_SOON_SECONDS, compactRelative, exactTime } from '../../format';

export const STALE_SECONDS = 60;
const tagFor = (row: BoardRow, now: number): [string, string] => row.status === 'Open' ? (row.closesAt - now < CLOSING_SOON_SECONDS ? ['soon', 'Closes soon'] : ['open', 'Open'])
  : row.status === 'Closed' ? ['closed', 'Closed'] : row.status === 'Settled' ? ['settled', 'Settled'] : ['closed', 'Unavailable'];

// One market on the board: question, status, close time, linked count and the price pair. Prices older than a minute
// stay visible but dimmed with the time they were seen.
function MarketTile({ row, now, delta, watched, onWatch, onFocusGroup }: {
  row: BoardRow; now: number; delta: bigint | null; watched: boolean; onWatch: ((key: string) => void) | null; onFocusGroup: (group: string | null) => void;
}) {
  const [kind, label] = tagFor(row, now);
  const age = row.priceAt === null ? null : now - row.priceAt;
  const fresh = age !== null && age < STALE_SECONDS;
  const minutes = age === null ? 0 : Math.max(1, Math.round(age / 60));
  const price = (atoms: string | null | undefined) => <Price atoms={atoms} stale={!fresh}
    staleLabel={atoms ? `last seen ${formatAtoms(atoms)}, ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago` : undefined} fallback="Quote" />;
  return (
    <article className="market-card" data-group={row.groupKey} data-key={row.key}
      onPointerEnter={() => onFocusGroup(row.groupKey)} onPointerLeave={() => onFocusGroup(null)} onFocus={() => onFocusGroup(row.groupKey)}>
      <p className="tile-pool" title={`${row.groupLabel}. ${row.kindLabel}`}>{row.groupLabel}</p>
      {onWatch && <button type="button" className="tile-star" aria-pressed={watched} aria-label={watched ? 'Remove from watchlist' : 'Add to watchlist'} onClick={() => onWatch(row.key)}><Star aria-hidden="true" strokeWidth={1.75} /></button>}
      <h3 className="tile-q"><Link href={row.href()} title={row.question}>{row.question}</Link></h3>
      <div className="tile-meta">
        <span className={`tag tag-${kind}`}>{label}</span>
        <time dateTime={new Date(row.closesAt * 1000).toISOString()} title={exactTime(row.closesAt)}><span className="sr-only">{row.status === 'Open' ? 'Closes ' : 'Trading closed '}</span>{compactRelative(row.closesAt, now)}</time>
        {row.linkedCount > 1 && <span className="tile-linked" title={`${row.linkedCount} linked questions in ${row.groupLabel}`}><Link2 aria-hidden="true" strokeWidth={1.75} /><span className="sr-only">Linked questions: </span>{row.linkedCount}</span>}
        {delta !== null && <PriceDelta atoms={delta} />}
      </div>
      {row.status === 'Open'
        ? <div className="tile-prices">{[true, false].map((yes) => <Link key={String(yes)} className={`px${fresh ? '' : ' px-stale'}`} aria-label={(yes ? 'Yes: ' : 'No: ') + row.question} href={row.href(yes)}>
            <span>{yes ? 'Yes' : 'No'}</span>{price(yes ? row.prices?.yes : row.prices?.no)}</Link>)}</div>
        : <p className="tile-result">{row.status === 'Settled' ? row.payoutNote : 'Trading is unavailable. Open this market for its current resolution status.'}</p>}
    </article>
  );
}

export default memo(MarketTile);
