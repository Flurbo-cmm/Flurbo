import { useEffect, useState } from 'react';
import { appFetch } from './platform-fetch';
import type { PoolWeb } from '../shared/pool-web.mjs';

export type WebResponse = PoolWeb & { schema: 'flurbo.hybrid-web.v1'; pool: string; title: string; closesAt: number;
  blockNumber: string; observedAt: number; estimated: boolean; questions: string[] };

export function useWeb(id: string) {
  const [web, setWeb] = useState<WebResponse | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    setError('');
    void appFetch(`/api/hybrid/${id}/web`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw Error('The connections could not load.');
        const value = await response.json() as WebResponse;
        if (value.schema !== 'flurbo.hybrid-web.v1' || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) throw Error('Invalid connections.');
        return value;
      }).then(value => { if (!controller.signal.aborted) setWeb(value); })
      .catch(() => { if (!controller.signal.aborted) setError('The connections could not load. Try again.'); });
    return () => controller.abort();
  }, [id, attempt]);
  return { web, error, retry: () => setAttempt(n => n + 1) };
}
