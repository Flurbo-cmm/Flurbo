// Text and choices of the conditionals page, kept pure so they are tested without a browser.
import { formatUnits } from 'viem';
import { COMBINATION_LIMIT_MESSAGE } from '../shared/pilot.mjs';

export type Side = 'yes' | 'no';
export type Leg = { eventIndex: number; side: Side };
export type Chances = { condition: number | null; target: number | null; given: number | null; givenNot: number | null };
export type DecodedLegs = { rule: string; legs: { event: number; yes: boolean }[] } | null;

export const CONDITIONAL_COPY = {
  title: 'Conditional predictions',
  lead: 'A prediction that counts only if something else happens first.',
  explain: 'Choose the If answer and the Then answer. You are paid on the Then answer when the If answer happens, and refunded in full when it does not.',
  forkIntro: 'The pool\'s chance of the Then answer in both cases.',
  spread: 'Conditionals on unlikely conditions cost more above the pool\'s chance.',
  voidLine: 'If a question is Void, the payout averages its two answers, as for every Flurbo prediction.',
  tolerance: '0.5% price tolerance. A fresh price is checked when you review the transaction.',
  roundingUncertain: 'The pool cannot fix this chance to a tenth of a point right now. Refresh in a moment.',
  rareCondition: 'This If answer is too unlikely to condition on.',
  tooCertain: 'This conditional is too certain to buy: a share would cost more than it can pay.',
  empty: 'No conditional pools are open yet. Each one is listed here once it is deployed and verified.',
  unavailable: 'Conditional markets are unavailable right now. Refresh in a minute.',
  holdingsEmpty: 'You hold no conditional predictions in this pool yet.',
  conditionTicket: 'Buy the If question on its own, like any Flurbo question.',
} as const;

const word = (side: Side) => side === 'yes' ? 'Yes' : 'No';
const flip = (side: Side): Side => side === 'yes' ? 'no' : 'yes';
const q = (leg: Leg) => `Q${leg.eventIndex + 1}`;
export const legText = (leg: Leg) => `${q(leg)} is ${word(leg.side)}`;
export const amountText = (atoms: bigint) => `${formatUnits(atoms, 6)} test AUSD`;
export const chanceText = (value: number | null) => value === null ? 'Not available' : `${(value / 10).toFixed(1)}%`;
const reasonText = (reason: string | undefined) => reason === 'rare_condition' ? CONDITIONAL_COPY.rareCondition
  : reason ? CONDITIONAL_COPY.roundingUncertain : null;

// The three results a buyer can meet, in the order they are read: both happen, only the If answer happens, it does not.
export function payoffRows({ condition, target, shares, payAtoms }: { condition: Leg; target: Leg; shares: bigint; payAtoms: bigint }) {
  return {
    rows: [
      { key: 'both' as const, when: `${legText(condition)} and ${legText(target)}`, verb: 'Pays', atoms: shares, amount: amountText(shares) },
      { key: 'conditionOnly' as const, when: `${legText(condition)} and ${legText({ ...target, side: flip(target.side) })}`, verb: 'Pays', atoms: 0n, amount: amountText(0n) },
      { key: 'refund' as const, when: legText({ ...condition, side: flip(condition.side) }), verb: 'Refunds', atoms: payAtoms, amount: amountText(payAtoms) },
    ],
    voidLine: CONDITIONAL_COPY.voidLine,
  };
}

// The If question splits into its two answers; each branch carries the pool's chance of the Then answer.
export function decisionView({ condition, target, values, reasons }: { condition: Leg; target: Leg; values: Chances; reasons: Record<string, string> }) {
  const chosenYes = condition.side === 'yes';
  const branch = (side: Side) => {
    const key = (side === 'yes') === chosenYes ? 'given' : 'givenNot';
    return { side, label: `If ${word(side)}`, then: legText(target), chance: values[key], value: chanceText(values[key]),
      reason: values[key] === null ? reasonText(reasons[key]) : null, selected: side === condition.side };
  };
  const branches = [branch('yes'), branch('no')];
  const [yes, no] = branches.map(b => b.chance);
  const points = yes === null || no === null ? null : (yes - no) / 10;
  const named = `${q(target)} ${word(target.side)}`;
  const gap = points === null ? null : points === 0 ? `The pool gives ${named} the same chance either way.`
    : `The pool puts ${named} ${Math.abs(points).toFixed(1)} points ${points > 0 ? 'higher' : 'lower'} if ${q(condition)} is Yes than if it is No.`;
  return { condition: { label: `Chance ${legText(condition)}`, value: chanceText(values.condition),
    reason: values.condition === null ? reasonText(reasons.condition) : null }, branches, gap };
}

// Then candidates for a chosen If question; those the pool cannot price with it stay visible but disabled.
export function pairable(questions: { eventIndex: number; question: string; pairable: number[] }[], conditionEvent: number | null) {
  if (conditionEvent === null) return [];
  const allowed = new Set(questions.find(item => item.eventIndex === conditionEvent)?.pairable ?? []);
  return questions.filter(item => item.eventIndex !== conditionEvent).map(item => ({ eventIndex: item.eventIndex, question: item.question,
    disabled: !allowed.has(item.eventIndex), note: allowed.has(item.eventIndex) ? null : COMBINATION_LIMIT_MESSAGE }));
}

const legsText = (decoded: DecodedLegs) => decoded ? decoded.legs.map(leg => `Q${leg.event + 1} is ${leg.yes ? 'Yes' : 'No'}`)
  .join(decoded.rule === 'OR' ? ' or ' : decoded.rule === 'EXACTLY_ONE' ? ', exactly one of ' : ' and ') : null;

export function holdingLine({ condition, target }: { condition: DecodedLegs; target: DecodedLegs }) {
  const c = legsText(condition), t = legsText(target);
  return c && t ? `If ${c}, then ${t}` : 'A conditional prediction in this pool';
}
