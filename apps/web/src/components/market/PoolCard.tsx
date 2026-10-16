import { Link } from 'wouter';
import { PriceDelta } from '../ui/Price';
import { compactRelative, exactTime } from '../../format';
import { shortTitle } from '../../web-layout';
import type { PoolGroup } from '../../market-board-rows';

// One pool on the board: how many questions it prices together and when it closes. Opens the connections page.
export default function PoolCard({ group, now, deltas }: { group: PoolGroup; now: number; deltas: ReadonlyMap<string, bigint> }) {
  const movers = group.rows.flatMap(row => { const delta = deltas.get(row.key); return delta === undefined || delta === 0n ? [] : [{ row, delta }]; })
    .sort((a, b) => (b.delta > 0n ? b.delta : -b.delta) > (a.delta > 0n ? a.delta : -a.delta) ? 1 : -1).slice(0, 3);
  const closed = group.closesAt <= now;
  const href = group.webPath ?? group.rows[0].path;
  return <article className="pool-card">
    <h2><Link href={href}>{group.label}</Link></h2>
    <p className="pool-card-meta"><span>{group.count} {group.count === 1 ? 'question' : 'questions'}</span>
      <span className="chip">{group.open > 0 ? `${group.open} open` : 'None open'}</span>
      <span title={exactTime(group.closesAt)}>{closed ? `Closed ${compactRelative(group.closesAt, now)}` : `Closes ${compactRelative(group.closesAt, now)}`}</span></p>
    {movers.length > 0 && <ul className="pool-card-movers" aria-label="Biggest price moves">{movers.map(({ row, delta }) =>
      <li key={row.key}><span>{shortTitle(row.question, 8)}</span><PriceDelta atoms={delta} /></li>)}</ul>}
    <p className="pool-card-action">{group.webPath ? <Link href={group.webPath} className="text-link">See how they connect</Link> : <Link href={href} className="text-link">Open question</Link>}</p>
  </article>;
}
