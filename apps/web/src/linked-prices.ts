type Reader = (id: string) => Promise<{ prices?: { yes?: string | null } | null }>;

// Live Yes prices for the other questions of a pool, so a direct link does not depend on a recently visited board.
export async function fetchLinkedPrices(ids: string[], read: Reader, cached: (id: string) => string | null,
  limit = 4, signal?: AbortSignal): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  let next = 0;
  const worker = async () => {
    while (next < ids.length && !signal?.aborted) {
      const id = ids[next++];
      try {
        const yes = (await read(id)).prices?.yes;
        if (signal?.aborted) return;
        result[id] = typeof yes === 'string' && /^\d+$/.test(yes) ? yes : null;
      } catch {
        if (signal?.aborted) return;
        result[id] = cached(id);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, ids.length) }, worker));
  return result;
}
