import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { formatUnits } from 'viem';
import QuantityStepper from '../ui/QuantityStepper';
import ConditionalPayoffs from './ConditionalPayoffs';
import { APPROVAL_LABEL, quoteWaitText } from '../../ticket-copy';
import { CONDITIONAL_COPY, chanceText, legText, type Leg } from '../../conditional-view';
import type { ConditionalQuote } from '../../conditionals-client';

const cash = (atoms: string) => formatUnits(BigInt(atoms), 6);

// The conditional as a two-line slip (If, then Then), the share count, the named price and the three results.
export default function ConditionalTicket({ condition, target, conditionQuestion, targetQuestion, wallet, shares, onShares, quote, quoteError,
  quoteSlow, open, owner, busy, blocked, notice, alert, onReview, onRefresh }: {
  condition: Leg; target: Leg; conditionQuestion: string; targetQuestion: string; wallet: ReactNode; shares: string; onShares(value: string): void;
  quote: ConditionalQuote | null; quoteError: string; quoteSlow: boolean; open: boolean; owner: string; busy: boolean; blocked: boolean;
  notice: string; alert: ReactNode; onReview(action: 'approve' | 'buy'): void; onRefresh(): void;
}) {
  const pay = quote ? BigInt(quote.payAtoms) : null;
  const needsApproval = !!quote && quote.allowanceAtoms !== null && BigInt(quote.allowanceAtoms) < BigInt(quote.payAtoms);
  const funded = !!quote && quote.cashAtoms !== null && BigInt(quote.cashAtoms) >= BigInt(quote.payAtoms);
  const given = quote ? quote.chances.given : null;
  return <section className="detail-panel detail-trade cond-ticket" aria-label="Your conditional prediction" data-conditional-section="ticket">
    <div className="consumer-ticket">
      <div className="ticket-head"><h2 tabIndex={-1} id="cond-ticket-heading">Your conditional prediction</h2>
        <p className="market-caption">{CONDITIONAL_COPY.explain}</p></div>
      {alert}
      {notice && <p className="state-inline" role="status">{notice}</p>}
      {wallet}
      <ol className="slip-legs cond-slip" aria-label="Your conditional">
        <li className="slip-leg"><span className="slip-q">Q{condition.eventIndex + 1}</span>
          <div className="slip-body"><span className="slip-this">If {legText(condition)}</span><p className="slip-question">{conditionQuestion}</p></div></li>
        <li className="slip-join" aria-hidden="true"><span>then</span></li>
        <li className="slip-leg"><span className="slip-q">Q{target.eventIndex + 1}</span>
          <div className="slip-body"><span className="slip-this">Then {legText(target)}</span><p className="slip-question">{targetQuestion}</p></div></li>
      </ol>
      {open ? <>
        <QuantityStepper label="Shares" value={shares} onChange={onShares} max={20} />
        <div className="ticket-quote-state" aria-live="polite">
          {!quote && <p className={`ticket-status${quoteError ? ' ticket-status-error' : ''}`} role="status">{quoteError || quoteWaitText(quoteSlow)}</p>}
          <button type="button" className="text-link ticket-refresh" disabled={busy} onClick={onRefresh}>Refresh price</button>
        </div>
        {quote && pay !== null && <div className="ticket-review ticket-quote" aria-label="Current conditional quote">
          <dl className="review-figures leaders">
            <div><dt>Price per share</dt><dd>{cash(quote.perShare)} test AUSD</dd></div>
            <div className="review-cost"><dt>You pay</dt><dd>{cash(quote.payAtoms)} test AUSD</dd></div>
            <div><dt>Pool chance {legText(target)} if {legText(condition)}</dt><dd>{chanceText(given)}</dd></div>
          </dl>
          <p className="market-caption cond-spread">{CONDITIONAL_COPY.spread}</p>
          <ConditionalPayoffs condition={condition} target={target} shares={BigInt(quote.shares)} payAtoms={pay} />
          <p className="market-caption">{CONDITIONAL_COPY.tolerance}</p>
          {owner && !funded && <p role="status">Your wallet needs at least {cash(quote.payAtoms)} test AUSD. <Link href="/fund" className="text-link">Get test funds</Link></p>}
          <button type="button" className="btn btn-primary btn-block" disabled={!owner || busy || blocked || !funded}
            onClick={() => onReview(needsApproval ? 'approve' : 'buy')}>{!owner ? 'Connect MetaMask to predict' : needsApproval ? APPROVAL_LABEL : 'Review prediction'}</button>
        </div>}
      </> : <p className="ticket-status" role="status">Trading in this pool is closed. Collect what each conditional pays below once every question is final.</p>}
    </div>
  </section>;
}
