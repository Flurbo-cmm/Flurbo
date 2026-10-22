import type { ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import StatusBadge from '../ui/StatusBadge';
import Stepper from '../ui/Stepper';
import { outcomeLabels, type settlementView, type TimelineSnapshot } from '../../settlement-timeline';

export type SummarySnapshot = TimelineSnapshot & { proposal: number; result: number; challengeUntil: number; sourceCaseId: string;
  reality: null | (NonNullable<TimelineSnapshot['reality']> & { answerLabel: string | null;
    court: null | { disputeId: string; periodLabel: string; period: number; periodEndsAt: number | null; votesNeeded: number; votesCast: number };
    links: { questionTx: string | null; reality: string; courtContract: string | null } }) };

// The read side of one question's settlement. Pages add their own actions as children.
export default function SettlementSummary({ snapshot, view, format, picker, children }: { snapshot: SummarySnapshot;
  view: ReturnType<typeof settlementView>; format: (seconds: number) => string; picker?: ReactNode; children?: ReactNode }) {
  const reality = snapshot.reality;
  return <section className="detail-panel detail-settlement" aria-label="Settlement timeline"><div className="panel-head"><h2>From prediction to payout</h2><StatusBadge kind={view.status}>{view.statusText}</StatusBadge></div>
    {picker}
    <p>{reality ? 'Your shares stay in your wallet while the event runs. Reality.eth accepts bonded answers and Kleros hears disputes.'
      : 'Your shares stay in your wallet while the event runs. The source rule fixes the answer. Kleros hears a challenged answer.'}</p><Stepper steps={view.steps} label="Settlement steps"/>
    {reality?.court && <p className="market-caption">Kleros case #{reality.court.disputeId}: {reality.court.periodLabel}.
      {reality.court.periodEndsAt ? ` Ends ${format(reality.court.periodEndsAt)}.` : ''}
      {reality.court.period === 2 && reality.court.votesCast < reality.court.votesNeeded ? ' Waiting for the juror vote.' : ''}</p>}
    {reality && view.waiting && !view.hasRealityAnswer && !reality.finalized && <p className="market-caption">{view.waiting.caption}</p>}
    {reality && <p className="market-caption settlement-links">
      <a className="text-link" href={reality.links.reality} target="_blank" rel="noreferrer">Reality.eth question <ArrowUpRight size={14}/></a>
      {reality.links.courtContract && <a className="text-link" href={reality.links.courtContract} target="_blank" rel="noreferrer">Court contract on Etherscan <ArrowUpRight size={14}/></a>}
      {reality.links.questionTx && <a className="text-link" href={reality.links.questionTx} target="_blank" rel="noreferrer">Question transaction <ArrowUpRight size={14}/></a>}</p>}
    {reality && view.hasRealityAnswer && <p>Current Reality.eth answer: <strong>{reality.answerLabel}</strong>. {view.canArbitrate ? `Challenge before ${format(reality.finalizesAt)}.` : ''}</p>}
    {reality?.pendingArbitration && <p>The answer is under Kleros review. Payout waits for the final Reality.eth result.</p>}
    {snapshot.phase === 1 && <p>Proposed answer: <strong>{outcomeLabels[snapshot.proposal]}</strong>. Challenge before {format(snapshot.challengeUntil)}.</p>}
    {snapshot.phase === 2 && <p>{/^0x0{64}$/i.test(snapshot.sourceCaseId)
      ? 'Kleros case requested. If a case cannot be linked before the published deadline, this question becomes Void.'
      : 'Kleros case linked. The result waits for its final ruling.'}</p>}
    {snapshot.phase === 3 && <p>Final answer: <strong>{outcomeLabels[snapshot.result]}</strong>.</p>}
    <p className="market-caption">Each payout needs every question in this shared pool to be final.</p>
    {children}
  </section>;
}
