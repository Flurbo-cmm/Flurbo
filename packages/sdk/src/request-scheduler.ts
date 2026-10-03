// Cooperative transport protection. Server limits remain authoritative; a
// modified client can bypass these local controls. No request is retried here.
export function retryAfterMs(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  const n = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}
export function requestScheduler({ concurrency = 4, queueLimit = 64, perWindow = 100, windowMs = 60_000, now = Date.now } = {}) {
  let active = 0, waiting = 0, blockedUntil = 0;
  const starts: number[] = [];
  const pause = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
  return {
    cooldown(value: string | null) { blockedUntil = Math.max(blockedUntil, now() + (retryAfterMs(value, now()) || 1000)); },
    async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (waiting >= queueLimit) throw new Error('Request queue full. Retry shortly.');
      waiting++;
      try {
        while (true) {
          if (signal?.aborted) throw signal.reason;
          const t = now();
          while (starts.length && starts[0] <= t - windowMs) starts.shift();
          if (active < concurrency && starts.length < perWindow && t >= blockedUntil) { active++; starts.push(t); break; }
          await pause(Math.min(1000, Math.max(10, blockedUntil - t, starts.length >= perWindow ? starts[0] + windowMs - t : 10)), signal);
        }
      } finally { waiting--; }
      try { return await work(); } finally { active--; }
    },
  };
}
const schedulers = new Map<string, ReturnType<typeof requestScheduler>>();
export function schedulerFor(url: string, lane = 'api') {
  const origin = lane + ':' + new URL(url, 'https://relative.flurbo.invalid').origin;
  let scheduler = schedulers.get(origin);
  if (!scheduler) {
    // Do not evict active budgets: excessive distinct origins fail closed.
    if (schedulers.size >= 64) throw new Error('Too many request origins.');
    // Six API requests at once, the usual browser limit per site, so a page's parallel reads (one per wallet,
    // for example) finish in one round; chain reads stay at four.
    scheduler = requestScheduler({perWindow:lane==='rpc'?600:100,concurrency:lane==='rpc'?4:6}); schedulers.set(origin, scheduler);
  }
  return scheduler;
}
export const scheduledFetch: typeof fetch = (input, init) => governedFetch(input,init,'api');
export const scheduledRpcFetch: typeof fetch = (input, init) => governedFetch(input,init,'rpc');
const governedFetch = async (input: RequestInfo | URL, init: RequestInit | undefined, lane: string): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const scheduler = schedulerFor(url,lane);
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined) ?? undefined;
  return scheduler.run(async () => {
    const response = await globalThis.fetch(input, init);
    if (response.status === 429) scheduler.cooldown(response.headers.get('Retry-After'));
    return response;
  }, signal);
};
