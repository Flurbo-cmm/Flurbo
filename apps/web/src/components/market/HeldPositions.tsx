import { Link } from 'wouter';
import { formatUnits } from 'viem';
import { decodeClaim, claimEvents } from '../../../shared/claims.mjs';
import { hybridClaimHref } from '../../portfolio-groups';
import { positionLine, type Rule } from '../../ticket-copy';
import type { AccountHolding } from '../../account-holdings';

export type HeldRow = AccountHolding & { rule: Rule; legs: { eventIndex: number; side: 'yes' | 'no' }[] };

// Describes each held claim by question number and rule. Claims without an exact named rule are left to the portfolio.
export function describeHoldings(rows: AccountHolding[], events: number): { rows: HeldRow[]; unnamed: number } {
  const named: HeldRow[] = [];
  let unnamed = 0;
  for (const row of rows) {
    let decoded: ReturnType<typeof decodeClaim> = null;
    try { decoded = decodeClaim(row.scope, row.mask, events); } catch { decoded = null; }
    if (!decoded || decoded.rule === 'AT_LEAST_TWO') { unnamed += 1; continue; }
    named.push({ ...row, rule: decoded.rule, legs: decoded.legs.map(leg => ({ eventIndex: leg.event, side: leg.yes ? 'yes' : 'no' })) });
  }
  return { rows: named, unnamed };
}

const shares = (atoms: string) => `${formatUnits(BigInt(atoms), 6)} ${BigInt(atoms) === 1_000_000n ? 'share' : 'shares'}`;
const lineOf = (row: HeldRow) => positionLine(row.rule, row.legs.map(leg => ({ number: leg.eventIndex + 1, side: leg.side })));

export default function HeldPositions({ rows, events, anchor, pool, mode, loading, complete, error, busy, onPick, onCollect }: {
  rows: AccountHolding[]; events: number; anchor: number; pool: string; mode: 'sell' | 'collect'; loading: boolean; complete: boolean; error: string; busy: boolean;
  onPick(row: HeldRow): void; onCollect(row: HeldRow): void;
}) {
  const { rows: described, unnamed } = describeHoldings(rows, events);
  const includes = (row: HeldRow) => row.legs.some(leg => leg.eventIndex === anchor);
  const shown = (mode === 'collect' ? described.filter(row => row.legs.length > 1 || !includes(row)) : described)
    .sort((a, b) => Number(includes(b)) - Number(includes(a)) || Number(BigInt(b.quantity) - BigInt(a.quantity)));
  return <section className="held" aria-label="Your positions in this pool">
    <h3>{mode === 'collect' ? 'Your combined positions' : 'Your positions in this pool'}</h3>
    {loading && !shown.length && <p className="slip-status" role="status">Reading your positions in this pool...</p>}
    {!loading && !shown.length && !error && complete && <p className="slip-note">This wallet holds no shares in this pool.</p>}
    {(error || !complete && !loading) && <p className="slip-note" role="status">Some positions could not be read. Refresh, or find another combination below.</p>}
    {shown.length > 0 && <ul className="held-list">{shown.map(row => {
      const own = includes(row), payout = row.payoutAtoms ?? '0', first = claimEvents(row.scope)[0], href = hybridClaimHref(pool, row.scope, row.mask);
      return <li key={`${row.scope}:${row.mask}`} className="held-row">
        <p className="held-line">{lineOf(row)}</p>
        <p className="held-meta">{shares(row.quantity)}{mode === 'collect' ? ` · ${BigInt(payout) > 0n ? `${formatUnits(BigInt(payout), 6)} test AUSD` : 'No payout'}` : ''}</p>
        {mode === 'sell' && own && <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onPick(row)}>Sell this position</button>}
        {mode === 'sell' && !own && <Link className="btn btn-secondary btn-sm" href={`${href}&trade=sell`}>Sell on Q{first + 1}</Link>}
        {mode === 'collect' && own && BigInt(payout) > 0n && <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onCollect(row)}>Collect {formatUnits(BigInt(payout), 6)} test AUSD</button>}
        {mode === 'collect' && !own && <Link className="btn btn-secondary btn-sm" href={href}>Open Q{first + 1}</Link>}
      </li>;
    })}</ul>}
    {unnamed > 0 && <p className="slip-caption">{unnamed} {unnamed === 1 ? 'position has' : 'positions have'} no description here. <Link className="text-link" href="/portfolio">Find {unnamed === 1 ? 'it' : 'them'} in your portfolio.</Link></p>}
  </section>;
}
