import { payoffRows, type Leg } from '../../conditional-view';

// The three results, marked like the outcome map: what pays is lime, what pays nothing is dashed, the refund is hollow.
export default function ConditionalPayoffs({ condition, target, shares, payAtoms }: { condition: Leg; target: Leg; shares: bigint; payAtoms: bigint }) {
  const view = payoffRows({ condition, target, shares, payAtoms });
  return <div className="cond-payoffs">
    <h3>What it pays</h3>
    <ul aria-label="What it pays">
      {view.rows.map(row => <li key={row.key} data-key={row.key}>
        <span className="cond-payoff-mark" aria-hidden="true" />
        <span className="cond-payoff-when">If {row.when}</span>
        <span className="cond-payoff-amount">{row.verb} {row.amount}</span>
      </li>)}
    </ul>
    <p className="cond-void">{view.voidLine}</p>
  </div>;
}
