import type { Step } from './components/ui/Stepper.tsx';
import type { StatusKind } from './components/ui/StatusBadge.tsx';
import { awaitingAnswer } from './settlement-copy.ts';

export type TimelineSnapshot = { closesAt: number; observationEndsAt: number; marketNow: number; resolved: boolean; phase: number;
  reportDeadline: number; ruleAdapter?: string | null; automaticAnswer?: { outcome: number } | null;
  reality: null | { sourceNow: number; opensAt: number; finalizesAt: number; bondWei: string; finalized: boolean;
    pendingArbitration: boolean; disputeStatus: number; court: null | { disputeId: string; periodLabel: string } } };

export const outcomeLabels = ['Waiting', 'No', 'Yes', 'Void'];

// Where one question stands between trading and payout. Both the hybrid market page and the conditional pool page read it.
export function settlementView({ snapshot, closesAt, observationEndsAt, now, format }: { snapshot: TimelineSnapshot | null;
  closesAt: number; observationEndsAt: number; now: number; format: (seconds: number) => string }) {
  const closed = snapshot ? snapshot.marketNow >= snapshot.closesAt : now >= closesAt;
  const reality = snapshot?.reality;
  const hasRealityAnswer = reality ? BigInt(reality.bondWei) > 0n : false;
  const canAnswer = !!reality && !reality.finalized && !reality.pendingArbitration
    && reality.sourceNow >= reality.opensAt && (!hasRealityAnswer || reality.sourceNow < reality.finalizesAt);
  const canArbitrate = !!reality && hasRealityAnswer && !reality.finalized
    && !reality.pendingArbitration && reality.sourceNow < reality.finalizesAt;
  const status: StatusKind = snapshot?.resolved ? 'collect' : reality?.pendingArbitration ? 'disputed'
    : canArbitrate ? 'challenge' : snapshot?.phase === 2 ? 'disputed'
    : snapshot?.phase === 1 ? 'challenge' : closed ? 'closed' : 'open';
  const statusText = snapshot?.resolved ? 'Collect' : reality?.pendingArbitration ? 'Kleros review'
    : canArbitrate ? 'Answer open for challenge' : reality?.finalized ? 'Final answer, awaiting relay'
    : reality && !hasRealityAnswer && reality.sourceNow >= reality.opensAt ? 'Awaiting bonded answer'
    : snapshot?.phase === 2 ? 'Kleros review'
    : snapshot?.phase === 1 ? 'Answer open for challenge' : snapshot?.phase === 3 ? 'Result final, awaiting pool'
      : closed ? 'Trading closed' : 'Open for predictions';
  const disputed = !!reality && reality.disputeStatus > 0;
  const courtActive = disputed || snapshot?.phase === 2;
  const finalIndex = courtActive ? 5 : 4;
  const relayIndex = finalIndex + 1;
  const payoutIndex = reality ? finalIndex + 2 : courtActive ? 6 : 5;
  const stage = reality ? snapshot?.resolved || snapshot?.phase === 3 ? payoutIndex : reality.finalized ? relayIndex
    : disputed ? 4 : hasRealityAnswer ? 3 : reality.sourceNow >= reality.opensAt ? 2 : closed ? 1 : 0
    : snapshot?.resolved ? payoutIndex : snapshot?.phase === 3 ? finalIndex
    : snapshot?.phase === 2 ? 4
    : snapshot?.phase === 1 ? 3 : snapshot && snapshot.marketNow >= snapshot.observationEndsAt ? 2 : closed ? 1 : 0;
  const step = (key: string, title: string, meta: string, index: number): Step => ({ key, title, meta,
    state: index < stage ? 'done' : index === stage ? 'current' : 'upcoming' });
  const readerLabel = snapshot?.automaticAnswer ? outcomeLabels[snapshot.automaticAnswer.outcome] : null;
  const waiting = reality && snapshot ? awaitingAnswer({ automatic: !!snapshot.ruleAdapter, opensAt: reality.opensAt, now: reality.sourceNow,
    reportDeadline: snapshot.reportDeadline, format }) : null;
  const steps: Step[] = reality ? [
    step('trading', 'Trading', `Closes ${format(closesAt)}`, 0),
    step('source', 'Source observed', `Reader window ends ${format(observationEndsAt)}`, 1),
    step('proposal', hasRealityAnswer ? 'Answer posted' : 'Awaiting answer',
      readerLabel ? `Flurbo reader answered ${readerLabel}` : hasRealityAnswer
        ? 'A bonded answer was posted on Reality.eth' : waiting!.meta, 2),
    step('challenge', 'Challenge window', reality.finalizesAt > 0 ? `Until ${format(reality.finalizesAt)}`
      : 'Opens when the first answer is posted', 3),
    ...(disputed ? [step('court', 'Kleros review', reality.court
      ? `Case #${reality.court.disputeId}: ${reality.court.periodLabel}` : 'Jurors review the disputed answer', 4)] : []),
    step('final', 'Final on Reality.eth', 'Reality.eth finalizes the answer on Sepolia', finalIndex),
    step('relay', 'Reported to Monad', 'The relay delivers the final answer to this pool', relayIndex),
    step('payout', 'Payouts', 'Available when every question in this pool is final', payoutIndex),
  ] : [
    step('trading', 'Trading', `Closes ${format(closesAt)}`, 0),
    step('source', 'Source observed', `Window ends ${format(observationEndsAt)}`, 1),
    step('proposal', 'Answer proposed', 'The committed reader posts a bonded source result', 2),
    step('challenge', 'Challenge window', 'A different answer can be bonded in Flurbo', 3),
    ...(snapshot?.phase === 2 ? [step('court', 'Kleros review', 'Jurors review both evidence records', 4)] : []),
    step('final', 'Final answer', 'The result is final after the window or Kleros ruling', finalIndex),
    step('payout', 'Payouts', 'Available when every question in this pool is final', payoutIndex),
  ];
  return { closed, hasRealityAnswer, canAnswer, canArbitrate, status, statusText, steps, readerLabel, waiting };
}
