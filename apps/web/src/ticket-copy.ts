export type Rule = 'AND' | 'OR' | 'EXACTLY_ONE';

export const APPROVAL_LABEL = 'Review AUSD approval (step 1 of 2)';

export const TICKET_INTRO = 'Each share pays 1 test AUSD if your prediction is right. Add up to two linked questions to combine them.';

export const quoteErrorMessage = (kind: 'unpriceable' | 'unavailable') => kind === 'unpriceable'
  ? 'The pool cannot price these questions together. Remove an answer or choose another question.'
  : 'A current quote is unavailable. Refresh and try again.';

export const RULE_OPTIONS = [{ value: 'AND' as const, label: 'All correct' }, { value: 'OR' as const, label: 'At least one' },
  { value: 'EXACTLY_ONE' as const, label: 'Exactly one' }];
export const ruleWord = (rule: Rule) => rule === 'AND' ? 'and' : rule === 'OR' ? 'or' : 'exactly one of';
export const rulePhrase = (rule: Rule) => rule === 'AND' ? 'Pays when all are correct'
  : rule === 'OR' ? 'Pays when at least one is correct' : 'Pays when exactly one is correct';

type Leg = { number: number; side: 'yes' | 'no' };
const sideText = (side: 'yes' | 'no') => side === 'yes' ? 'Yes' : 'No';
const listWith = (items: string[], word: string) => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}`;

export const payoutSentence = (rule: Rule, legs: Leg[]) => {
  const start = 'Pays 1 test AUSD a share if';
  if (legs.length === 1) return `${start} Q${legs[0].number} is ${sideText(legs[0].side)}.`;
  const named = legs.map(leg => `Q${leg.number} ${sideText(leg.side)}`);
  if (rule === 'AND') return `${start} ${listWith(legs.map(leg => `Q${leg.number} is ${sideText(leg.side)}`), 'and')}.`;
  return rule === 'OR' ? `${start} at least one is right: ${listWith(named, 'or')}.`
    : `${start} exactly one is right: ${listWith(named, 'or')}. Two or more right pays nothing.`;
};

export const positionLine = (rule: Rule, legs: Leg[]) => {
  const named = legs.map(leg => `Q${leg.number} ${sideText(leg.side)}`);
  if (legs.length === 1) return named[0];
  return rule === 'AND' ? `${listWith(named, 'and')}, all correct`
    : rule === 'OR' ? `${listWith(named, 'or')}, at least one correct` : `${listWith(named, 'or')}, exactly one correct`;
};

const shareText = (atoms: bigint) => {
  const whole = atoms / 1_000_000n, fraction = (atoms % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
};

export const sellBlockedMessage = (holdingsAtoms: string) => {
  const held = BigInt(holdingsAtoms || '0');
  if (held === 0n) return 'You hold no shares of this prediction in this wallet.';
  return `You hold ${shareText(held)} ${held === 1_000_000n ? 'share' : 'shares'} of this prediction. Lower the amount to sell.`;
};

export const tradeSummary = (shares: string, rule: Rule, legs: { question: string; side: 'yes' | 'no' }[]) =>
  [`${shares} ${Number(shares) === 1 ? 'share' : 'shares'}`, ...(legs.length > 1 ? [rule.replace('_', ' ')] : []),
    ...legs.map(leg => `${leg.question}: ${leg.side === 'yes' ? 'Yes' : 'No'}`)].join(' · ');

// The wallet line of the ticket: what to say while the balance is read, when it cannot be read, and once it is known.
export const balanceLabel = ({ owner, snapshotLoaded, cashAtoms, error }: { owner: string | null; snapshotLoaded: boolean; cashAtoms: string | null; error: boolean }) =>
  !owner ? 'MetaMask signs each trade and bond you review'
    : snapshotLoaded && cashAtoms !== null ? `${shareText(BigInt(cashAtoms))} test AUSD`
      : error ? 'Balance unavailable. Refresh.' : 'Reading balance...';

export const monadTxUrl = (hash: string) => /^0x[0-9a-fA-F]{64}$/.test(hash) ? `https://testnet.monadscan.com/tx/${hash}` : null;

export const quoteWaitText = (slow: boolean) => slow
  ? 'Still reading the pool quote. Monad may be slow; this retries on its own.' : 'Reading the current pool quote...';
