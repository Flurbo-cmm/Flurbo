import { CONDITIONAL_COPY, decisionView, type Chances, type Leg, type Side } from '../../conditional-view';

// The If question splits into its two answers. Each branch carries the pool's chance of the Then answer; the chosen
// branch is drawn in ink with the lime joint, the other stays a dotted rule.
export default function DecisionView({ condition, target, conditionQuestion, values, reasons, loading, error, onPredict }: {
  condition: Leg; target: Leg; conditionQuestion: string; values: Chances | null; reasons: Record<string, string>;
  loading: boolean; error: string; onPredict(side: Side): void;
}) {
  const view = decisionView({ condition, target, values: values ?? { condition: null, target: null, given: null, givenNot: null }, reasons });
  const pending = !values;
  return <section className="cond-fork" aria-label="Both cases" aria-busy={loading || undefined} data-conditional-section="decision">
    <div className="cond-section-head"><h2>Both cases</h2><p className="market-caption">{CONDITIONAL_COPY.forkIntro}</p></div>
    {error && <p className="state-inline error" role="alert">{error}</p>}
    <div className="cond-fork-root">
      <span className="slip-q">Q{condition.eventIndex + 1}</span>
      <p className="cond-fork-question" title={conditionQuestion}>{conditionQuestion}</p>
      <dl className="cond-fork-chance"><dt>{view.condition.label}</dt><dd>{pending ? '...' : view.condition.value}</dd></dl>
      {view.condition.reason && <p className="cond-fork-reason">{view.condition.reason}</p>}
    </div>
    <ol className="cond-branches">
      {view.branches.map(branch => <li key={branch.side} className="cond-branch" data-branch={branch.side} data-selected={branch.selected}>
        <span className="cond-branch-joint" aria-hidden="true" />
        <span className="cond-branch-if">{branch.label}</span>
        <span className="cond-branch-rule" aria-hidden="true" />
        <span className="cond-branch-then">Then {branch.then}</span>
        <strong className="cond-branch-chance" aria-label={`${branch.label}, chance ${branch.then}: ${pending ? 'reading' : branch.value}`}>
          {pending ? '...' : branch.value}</strong>
        {branch.reason && <small className="cond-branch-reason">{branch.reason}</small>}
        <button type="button" className="btn btn-sm btn-secondary cond-branch-predict"
          aria-pressed={branch.selected} aria-label={`Predict if Q${condition.eventIndex + 1} is ${branch.side === 'yes' ? 'Yes' : 'No'}`}
          onClick={() => onPredict(branch.side)}>{branch.selected ? 'Chosen' : 'Predict'}</button>
      </li>)}
    </ol>
    {view.gap && <p className="cond-fork-gap">{view.gap}</p>}
  </section>;
}
