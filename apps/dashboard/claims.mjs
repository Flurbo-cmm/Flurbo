// Token amounts stay integers. The small Boolean truth table uses bit arithmetic.
export function parseUnits(text) {
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(text)) throw new Error('Enter a positive quantity with up to six decimal places.');
  const [whole, fraction = ''] = text.split('.');
  const value = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  if (value <= 0n || value >= 2n ** 128n) throw new Error('Quantity is outside the supported range.');
  return value.toString();
}

export function formatUnits(value, decimals = 6) {
  if (value === null || value === undefined) return '—';
  let amount = BigInt(value);
  const sign = amount < 0n ? '-' : '';
  if (amount < 0n) amount = -amount;
  const scale = 10n ** BigInt(decimals);
  const fraction = (amount % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return sign + (amount / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? '.' + fraction : '');
}

export function compileClaim(legs, mode, customMask = 0) {
  const sorted = [...legs].sort((a, b) => a.index - b.index);
  if (sorted.length < 1 || sorted.length > 3 || new Set(sorted.map(l => l.index)).size !== sorted.length ||
      sorted.some(l => !Number.isInteger(l.index) || l.index < 0 || l.index > 7 || typeof l.yes !== 'boolean')) {
    throw new Error('Choose one to three different events.');
  }
  if (!['all', 'any', 'custom'].includes(mode)) throw new Error('Choose a supported payout rule.');
  const count = 1 << sorted.length;
  let mask = 0;
  if (mode === 'custom') mask = customMask;
  else for (let state = 0; state < count; state++) {
    const matches = sorted.map((leg, i) => Boolean(state & (1 << i)) === leg.yes);
    if (mode === 'all' ? matches.every(Boolean) : matches.some(Boolean)) mask |= 1 << state;
  }
  if (!Number.isInteger(mask) || mask <= 0 || mask >= (1 << count) - 1) throw new Error('Select at least one winning outcome and one losing outcome.');
  return { scope: sorted.reduce((s, l) => s | (1 << l.index), 0), mask, legs: sorted };
}

export function claimLabel(legs, mode) {
  const sorted = [...legs].sort((a, b) => a.index - b.index);
  if (mode === 'custom') return `Custom payout · ${sorted.map(l => String.fromCharCode(65 + l.index)).join(', ')}`;
  return sorted.map(l => `${String.fromCharCode(65 + l.index)} ${l.yes ? 'YES' : 'NO'}`).join(mode === 'all' ? ' AND ' : ' OR ');
}

export function snapshotFresh(snapshot, now = Date.now() / 1000) {
  return !!snapshot && !snapshot.stale && now >= snapshot.timestamp && now - snapshot.timestamp <= 30;
}

export const REVIEW_SECONDS = 300;
export function quoteReviewable(quoted, now = Date.now() / 1000) {
  const timestamp = quoted?.snapshot?.timestamp, expiry = quoted?.quote?.valid_until;
  return Number.isSafeInteger(timestamp) && Number.isSafeInteger(expiry) && !quoted.snapshot.stale &&
    now >= timestamp && expiry > timestamp && expiry <= timestamp + REVIEW_SECONDS && now < expiry;
}
