// After sign-in, return people to the app page they opened. Only same-origin app
// paths from this allow-list are accepted, so the value can never redirect elsewhere.
const KEY = 'flurbo.return-to';
const PATHS = [
  /^\/markets$/,
  /^\/markets\/(?:pilot|practice-[0-9a-f]{40})\/[0-3](?:\/thesis)?$/,
  /^\/portfolio$/,
  /^\/fund$/,
  /^\/access$/,
  /^\/agents$/,
  /^\/agents\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
];
const QUERIES = new Set(['', '?answer=no', '?answer=yes', '?challenge=1']);

export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 200 || !value.startsWith('/') || value.startsWith('//')) return null;
  const query = value.indexOf('?');
  const path = query < 0 ? value : value.slice(0, query);
  const search = query < 0 ? '' : value.slice(query);
  return PATHS.some((pattern) => pattern.test(path)) && QUERIES.has(search) ? value : null;
}

export function rememberReturnPath(value: string) {
  const safe = safeReturnPath(value);
  try { if (safe) sessionStorage.setItem(KEY, safe); else sessionStorage.removeItem(KEY); } catch { /* storage unavailable */ }
}

export function takeReturnPath(): string | null {
  try {
    const value = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    return safeReturnPath(value);
  } catch { return null; }
}
