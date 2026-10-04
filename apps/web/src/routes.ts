import { useEffect, useState, type ComponentType } from 'react';

// Signed-in pages load on demand so the public pages stay light. A page starts
// loading while the session and access checks run, so the loader covers both.
const loaders = {
  markets: () => import('./pages/Markets'),
  agents: () => import('./pages/Agents'),
  access: () => import('./pages/AccessPage'),
  fund: () => import('./pages/FundingPage'),
  evidence: () => import('./pages/EvidenceReview'),
  metrics: () => import('./pages/Metrics'),
  workspace: () => import('./pages/Workspace'),
} satisfies Record<string, () => Promise<{ default: ComponentType<any> }>>;

export type RouteKey = keyof typeof loaders;
const pages = new Map<RouteKey, ComponentType<any>>();
const pending = new Map<RouteKey, Promise<ComponentType<any>>>();

export function loadRoute(key: RouteKey) {
  const known = pages.get(key);
  if (known) return Promise.resolve(known);
  let request = pending.get(key);
  if (!request) {
    request = loaders[key]().then((module) => { pages.set(key, module.default); return module.default; });
    // A failed chunk can be retried; do not cache the rejection.
    request.catch(() => pending.delete(key));
    pending.set(key, request);
  }
  return request;
}

/** Warms the pages a signed-in member is likely to open next. */
export function preloadRoutes(keys: RouteKey[]) {
  const run = () => keys.forEach((key) => { void loadRoute(key).catch(() => undefined); });
  if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 3000 });
  else setTimeout(run, 1200);
}

export function useRoutePage(key: RouteKey | null) {
  const [, setVersion] = useState(0);
  const [error, setError] = useState<{ key: RouteKey; message: string } | null>(null);
  const Page = key ? pages.get(key) ?? null : null;
  useEffect(() => {
    if (!key || pages.has(key)) return;
    let live = true;
    loadRoute(key).then(() => { if (live) setVersion((v) => v + 1); }, () => { if (live) setError({ key, message: 'This page could not be loaded. Check your connection and try again.' }); });
    return () => { live = false; };
  }, [key]);
  const retry = () => { if (!key) return; setError(null); loadRoute(key).then(() => setVersion((v) => v + 1), () => setError({ key, message: 'This page could not be loaded. Check your connection and try again.' })); };
  return { Page, error: error && error.key === key ? error.message : null, retry };
}
