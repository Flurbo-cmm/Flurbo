import { FlurboError } from './errors.ts';

// Token and share amounts are integer atoms (bigint) internally and decimal strings at JSON boundaries.
// Floating point is never used for amounts, limits or payouts.
export const UINT128_MAX = (1n << 128n) - 1n;
export const AUSD_DECIMALS = 6;
export const ONE_SHARE = 1_000_000n; // One share pays one test AUSD (10^6 atoms) if it wins outright.
export const PPM = 1_000_000n;       // Probabilities in parts per million.

export function parseAtoms(value: unknown, label = 'amount'): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,38})$/.test(value)) throw new FlurboError('invalid_input', `Invalid ${label}.`);
  const atoms = BigInt(value);
  if (atoms > UINT128_MAX) throw new FlurboError('invalid_input', `Invalid ${label}.`);
  return atoms;
}

export const atomsToString = (atoms: bigint): string => {
  if (atoms < 0n) throw new FlurboError('invalid_input', 'Negative atom amounts are not serialised; use a signed field.');
  return atoms.toString();
};

// Signed values (profit and loss) cross JSON as optionally negative integer strings.
export function parseSignedAtoms(value: unknown, label = 'amount'): bigint {
  if (typeof value !== 'string' || !/^-?(0|[1-9][0-9]{0,38})$/.test(value) || value === '-0') throw new FlurboError('invalid_input', `Invalid ${label}.`);
  return BigInt(value);
}

// "1.25" with 6 decimals becomes 1250000n. Rejects excess precision instead of rounding silently.
export function parseDecimal(value: string, decimals = AUSD_DECIMALS): bigint {
  const match = /^(0|[1-9][0-9]{0,30})(?:\.([0-9]+))?$/.exec(value.trim());
  if (!match) throw new FlurboError('invalid_input', 'Enter a positive decimal amount.');
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) throw new FlurboError('invalid_input', `At most ${decimals} decimal places are supported.`);
  return BigInt(match[1]) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

export function formatAtoms(atoms: bigint, decimals = AUSD_DECIMALS): string {
  const negative = atoms < 0n, value = negative ? -atoms : atoms, unit = 10n ** BigInt(decimals);
  const whole = value / unit, fraction = (value % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return (negative ? '-' : '') + whole.toString() + (fraction ? '.' + fraction : '');
}

export const ceilDiv = (a: bigint, b: bigint): bigint => {
  if (b <= 0n || a < 0n) throw new FlurboError('invalid_input', 'Invalid division.');
  return (a + b - 1n) / b;
};

// Displays a ppm probability as a percentage with one decimal, rounding half up. Display only.
export function formatPpm(ppm: bigint): string {
  const tenths = (ppm * 1000n + PPM / 2n) / PPM;
  return `${tenths / 10n}.${tenths % 10n}%`;
}
