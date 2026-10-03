export type CombinationRule = 'all' | 'any' | 'exact1' | 'atLeast2' | 'AND' | 'OR' | 'EXACTLY_ONE' | 'AT_LEAST_TWO';

export function makeClaim(answers: Record<number, boolean>, mode: CombinationRule = 'all') {
  const events = Object.keys(answers).map(Number).sort((a, b) => a - b);
  if (!events.length || events.length > 3 || events.some(n => !Number.isInteger(n) || n < 0 || n > 7)) {
    throw new Error('Choose one to three questions.');
  }
  if ((mode === 'atLeast2' || mode === 'AT_LEAST_TWO') && events.length < 2) {
    throw new Error('Choose at least two questions for this combination rule.');
  }
  const scope = events.reduce((n, e) => n | (1 << e), 0);
  let mask = 0;
  for (let state = 0; state < 2 ** events.length; state++) {
    const match = events.map((event, i) => Boolean(state & (1 << i)) === answers[event]);
    const count = match.filter(Boolean).length;
    const wins =
      mode === 'all' || mode === 'AND'
        ? count === events.length
        : mode === 'any' || mode === 'OR'
        ? count > 0
        : mode === 'exact1' || mode === 'EXACTLY_ONE'
        ? count === 1
        : count >= 2;
    if (wins) mask |= 1 << state;
  }
  return { scope, mask: String(mask), events };
}

export function quantityAtoms(input: string) {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(input)) throw new Error('Enter a positive number with up to six decimal places.');
  const [whole, fraction = ''] = input.split('.');
  const value = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (value <= 0n || value >= 2n ** 128n) throw new Error('Share quantity is out of range.');
  return value.toString();
}

export type Analysis = {
  schema: string;
  model: string;
  chainId: number;
  pool: string;
  rulesHash: string;
  a: number;
  b: number;
  unit: string;
  snapshot: { blockNumber: string; blockHash: string; timestamp: number };
  expiresAt: number;
  stateDigest: string;
  closed: boolean;
  values: Record<'a' | 'b' | 'joint' | 'givenYes' | 'givenNo' | 'independent' | 'difference', number | null>;
  reasons: Record<string, string>;
};

export function validateAnalysis(data: Analysis, manifest: { pool: string; rulesHash: string }, a: number, b: number) {
  const keys = ['a', 'b', 'joint', 'givenYes', 'givenNo', 'independent', 'difference'] as const;
  if (
    data.schema !== 'flurbo.pair-analytics.v1' ||
    data.model !== 'factored-lmsr-pair-v1' ||
    data.chainId !== 10143 ||
    data.pool !== manifest.pool ||
    data.rulesHash !== manifest.rulesHash ||
    data.a !== a ||
    data.b !== b ||
    a === b ||
    data.unit !== 'tenths_of_percentage_point' ||
    !Number.isSafeInteger(data.expiresAt) ||
    data.expiresAt !== data.snapshot?.timestamp + 60 ||
    !/^0x[0-9a-f]{64}$/.test(data.snapshot.blockHash) ||
    !/^\d+$/.test(data.snapshot.blockNumber) ||
    !/^[0-9a-f]{64}$/.test(data.stateDigest) ||
    !data.values ||
    !data.reasons ||
    keys.some(
      k =>
        data.values[k] !== null &&
        (!Number.isInteger(data.values[k]) || data.values[k]! < (k === 'difference' ? -1000 : 0) || data.values[k]! > 1000)
    )
  )
    throw new Error('Comparison could not be verified. Refresh and try again.');
  return data;
}
