import { useEffect, useMemo, useState } from 'react';
import { appFetch } from './platform-fetch.ts';

export type WhatIfLeg = { eventIndex: number; side: 'yes' | 'no' };
export type WhatIfRule = 'AND' | 'OR' | 'EXACTLY_ONE';
export type WhatIfInput = { given: WhatIfLeg[]; claim?: { legs: WhatIfLeg[]; rule: WhatIfRule } };
export type WhatIfCell = { state: number; answers: WhatIfLeg[]; pays: boolean; chance: number | null };
export type WhatIf = {
  schema: 'flurbo.hybrid-what-if.v1'; pool: string; blockNumber: string; blockHash: string; observedAt: number; closed: boolean;
  unit: 'tenths_of_percentage_point'; given: WhatIfLeg[]; givenChance: number | null;
  questions: { eventIndex: number; yes: number | null; givenYes: number | null; assumed: boolean }[];
  claim: null | { scope: number; mask: string; rule: WhatIfRule; legs: WhatIfLeg[]; chance: number | null; independent: number | null;
    difference: number | null; cells: WhatIfCell[]; priceable: boolean; addable: number[] };
  reasons: Record<string, unknown>;
};

const CACHE_SIZE = 20, FRESH_MS = 30_000, FAILURE = 'The pool comparison could not load. Refresh to try again.';
const cache = new Map<string, { value: WhatIf; at: number }>();
const sorted = (legs: WhatIfLeg[]) => [...legs].sort((a, b) => a.eventIndex - b.eventIndex).map(({ eventIndex, side }) => ({ eventIndex, side }));
const normal = (input: WhatIfInput) => ({ given: sorted(input.given),
  ...(input.claim ? { claim: { legs: sorted(input.claim.legs), rule: input.claim.legs.length === 1 ? 'AND' : input.claim.rule } } : {}) });
export const whatIfKey = (pool: string, input: WhatIfInput) => JSON.stringify([pool.toLowerCase(), normal(input)]);
export const clearWhatIfCache = () => cache.clear();

export function echoesRequest(value: WhatIf, pool: string, input: WhatIfInput) {
  if (!value || value.schema !== 'flurbo.hybrid-what-if.v1' || typeof value.pool !== 'string' || value.pool.toLowerCase() !== pool.toLowerCase()) return false;
  const wanted = normal(input);
  if (JSON.stringify(sorted(value.given ?? [])) !== JSON.stringify(wanted.given)) return false;
  if (!wanted.claim) return value.claim === null;
  return value.claim !== null && value.claim.rule === wanted.claim.rule
    && JSON.stringify(sorted(value.claim.legs ?? [])) === JSON.stringify(wanted.claim.legs);
}

export async function fetchWhatIf(marketId: string, pool: string, input: WhatIfInput,
  { signal, fetcher = appFetch, fresh = false, now = Date.now }: { signal?: AbortSignal; fetcher?: typeof fetch; fresh?: boolean; now?: () => number } = {}) {
  const key = whatIfKey(pool, input), cached = cache.get(key);
  if (cached && !fresh && now() - cached.at < FRESH_MS) {
    cache.delete(key);
    cache.set(key, cached);
    return cached.value;
  }
  const response = await fetcher(`/api/hybrid/${marketId}/what-if`, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(normal(input)), signal });
  if (!response.ok) throw Error(FAILURE);
  const value = await response.json() as WhatIf;
  if (!echoesRequest(value, pool, input)) throw Error('Invalid pool comparison.');
  cache.delete(key);
  cache.set(key, { value, at: now() });
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return value;
}

export function useWhatIf(marketId: string, pool: string, input: WhatIfInput | null) {
  const key = input ? whatIfKey(pool, input) : '';
  const request = useMemo(() => input, [key]);
  const [state, setState] = useState<{ key: string; result: WhatIf | null; error: string }>({ key: '', result: null, error: '' });
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!request) return;
    const timer = setInterval(() => { if (!document.hidden) setRevision(n => n + 1); }, FRESH_MS);
    return () => clearInterval(timer);
  }, [key]);
  useEffect(() => {
    if (!request) { setState({ key: '', result: null, error: '' }); setLoading(false); return; }
    setState({ key, result: cache.get(key)?.value ?? null, error: '' });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      fetchWhatIf(marketId, pool, request, { signal: controller.signal, fresh: revision > 0 })
        .then(result => { if (!controller.signal.aborted) setState({ key, result, error: '' }); })
        .catch(error => { if (!controller.signal.aborted) setState(old => ({ key, result: old.key === key ? old.result : null,
          error: error instanceof Error && error.message === 'Invalid pool comparison.' ? error.message : FAILURE })); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [marketId, pool, key, revision]);
  const current = state.key === key ? state : { key, result: null, error: '' };
  return { result: current.result, error: current.error, loading, refresh: () => setRevision(n => n + 1) };
}
