export type Rule = 'AND' | 'OR' | 'EXACTLY_ONE';

export const APPROVAL_LABEL = 'Review AUSD approval (step 1 of 2)';

export const quoteErrorMessage = (combined: boolean) => combined
  ? 'The pool cannot price this combination right now. Remove one answer or choose different answers.'
  : 'A current quote is unavailable. Refresh and try again.';

export const ruleHelp = (rule: Rule) => rule === 'AND' ? 'Pays only when every selected answer is correct.'
  : rule === 'OR' ? 'Pays when one or more selected answers are correct.'
    : 'Pays when exactly one selected answer is correct. If all are correct it is a loss.';

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

export const comboSummary = (mode: 'buy' | 'sell') => mode === 'sell' ? 'Sell a combined position' : 'Combine with another prediction';
export const comboHelp = (mode: 'buy' | 'sell') => mode === 'sell'
  ? 'Pick the same questions, answers and rule as the combined position you hold.' : null;

export const monadTxUrl = (hash: string) => /^0x[0-9a-fA-F]{64}$/.test(hash) ? `https://testnet.monadscan.com/tx/${hash}` : null;

export const quoteWaitText = (slow: boolean) => slow
  ? 'Still reading the pool quote. Monad may be slow; this retries on its own.' : 'Reading the current pool quote...';
