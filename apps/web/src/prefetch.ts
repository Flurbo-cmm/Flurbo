// Requests a page will need, started as early as the access rules allow instead of one after another. The access
// check starts as the app boots, alongside the sign-in check. Market data is never requested before the account is
// signed in and approved: it starts the moment the access check approves, all at once, instead of the market list
// first and the market after it. The page takes each answer once, within FRESH_MS of the request, and only when it
// succeeded; anything else (refused, slow or already taken) falls back to the page's own request.
const FRESH_MS = 10_000;
type Early = { at: number; promise: Promise<{ ok: boolean; status: number; text: string } | null> };
const early = new Map<string, Early>();

function prefetch(path: string) {
  if (early.has(path)) return;
  const promise = fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(20_000) })
    .then(async response => ({ ok: response.ok, status: response.status, text: await response.text() }))
    .catch(() => null);
  early.set(path, { at: Date.now(), promise });
}

// The early answer for this path, or null to make the request normally.
export async function takeEarly(path: string): Promise<Response | null> {
  const entry = early.get(path);
  if (!entry) return null;
  early.delete(path);
  if (Date.now() - entry.at > FRESH_MS) return null;
  const answer = await entry.promise;
  if (!answer?.ok) return null;
  return new Response(answer.text, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
}

const accountPage = (pathname: string) => /^\/(?:markets|portfolio|agents)(?:\/|$)/.test(pathname);

// At boot: the access check, which decides whether any market data may be read.
export function prefetchAccess(pathname: string) {
  if (accountPage(pathname)) prefetch('/api/account/access');
}

// Only once the access check has approved this account: the market data the current page shows.
export function prefetchApprovedData(pathname: string) {
  if (!/^\/(?:markets|portfolio)(?:\/|$)/.test(pathname)) return;
  prefetch('/api/market-directory');
  const market = /^\/markets\/(pilot|practice-[0-9a-f]{40})\/\d+$/.exec(pathname);
  if (market) { prefetch(`/api/${market[1]}/status`); prefetch(`/api/${market[1]}/markets`); }
}
