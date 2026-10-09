// Display helpers. Presentation only: never used to compute amounts that are signed or paid.
export const shortTime = (seconds: number) => new Date(seconds * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export const exactTime = (seconds: number) => new Date(seconds * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

export function relativeTime(seconds: number, nowSeconds = Date.now() / 1000) {
  const delta = seconds - nowSeconds, future = delta > 0, abs = Math.abs(delta);
  const unit = abs < 90 ? null : abs < 90 * 60 ? ['minute', Math.round(abs / 60)] as const : abs < 36 * 3600 ? ['hour', Math.round(abs / 3600)] as const : ['day', Math.round(abs / 86400)] as const;
  if (!unit) return future ? 'in under 2 minutes' : 'just now';
  const [name, count] = unit;
  const text = `${count} ${name}${count === 1 ? '' : 's'}`;
  return future ? `in ${text}` : `${text} ago`;
}

/** Closing within this window is shown as "Closing soon". Uses the close time already loaded. */
export const CLOSING_SOON_SECONDS = 24 * 3600;

export const shares = (value: string | number) => `${value} ${Number(value) === 1 ? 'share' : 'shares'}`;

/** Short relative time for dense layouts, for example "in 1h 40m", "in 3d", "5m ago". The exact time goes in a title. */
export function compactRelative(seconds: number, nowSeconds = Date.now() / 1000) {
  const delta = Math.round(seconds - nowSeconds), abs = Math.abs(delta);
  const minutes = Math.round(abs / 60), hours = Math.floor(minutes / 60);
  const text = abs < 60 ? 'now' : minutes < 60 ? `${minutes}m` : hours < 24 ? `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}` : `${Math.round(abs / 86400)}d`;
  if (text === 'now') return delta > 0 ? 'in under 1m' : 'just now';
  return delta > 0 ? `in ${text}` : `${text} ago`;
}
