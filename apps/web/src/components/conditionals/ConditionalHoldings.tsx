import { formatUnits } from 'viem';
import { CONDITIONAL_COPY, holdingLine } from '../../conditional-view';
import type { Holding, Holdings } from '../../conditionals-client';

const cash = (atoms: string) => formatUnits(BigInt(atoms), 6);

// Every conditional the wallet holds in this pool, with Sell while trading is open and Collect once it settles.
export default function ConditionalHoldings({ owner, holdings, loading, error, busy, onSell, onCollect, onRetry }: {
  owner: string; holdings: Holdings | null; loading: boolean; error: string; busy: boolean;
  onSell(row: Holding): void; onCollect(row: Holding): void; onRetry(): void;
}) {
  const rows = holdings?.holdings ?? [];
  return <section className="cond-holdings" aria-label="Your conditional predictions" data-conditional-section="holdings">
    <div className="cond-section-head"><h2>Your conditional predictions</h2></div>
    {!owner ? <p className="market-caption">Connect MetaMask to see what this wallet holds here.</p>
      : error ? <p className="state-inline error" role="alert">{error} <button type="button" className="text-link" onClick={onRetry}>Retry</button></p>
      : loading && !holdings ? <p role="status" className="market-caption">Reading your conditional predictions...</p>
      : !rows.length ? <p className="market-caption">{CONDITIONAL_COPY.holdingsEmpty}</p>
      : <ul className="cond-holding-rows">
        {rows.map(row => <li key={row.key} className="cond-holding">
          <p className="cond-holding-line">{holdingLine(row)}</p>
          <dl className="leaders">
            <div><dt>Shares</dt><dd>{cash(row.sharesAtoms)}</dd></div>
            <div><dt>Refund if the If answer fails</dt><dd>{cash(row.refundAtoms)} test AUSD</dd></div>
            {row.sellAtoms !== null && <div><dt>Sells now for about</dt><dd>{cash(row.sellAtoms)} test AUSD</dd></div>}
            {row.payoutAtoms !== null && <div className="review-cost"><dt>Payout</dt><dd>{cash(row.payoutAtoms)} test AUSD</dd></div>}
          </dl>
          {holdings?.resolved
            ? <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => onCollect(row)}>Collect {cash(row.payoutAtoms ?? '0')} test AUSD</button>
            : holdings?.open ? <button type="button" className="btn btn-secondary btn-sm" disabled={busy || row.sellAtoms === null}
              onClick={() => onSell(row)}>{BigInt(row.sharesAtoms) > 20_000_000n ? 'Sell 20 shares' : 'Sell'}</button>
            : <p className="market-caption">Collect opens when every question in this pool is final.</p>}
        </li>)}
      </ul>}
  </section>;
}
