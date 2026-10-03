import { useEffect, useRef, useState } from 'react';
export function useRequest<T>() {
  const [value, setValue] = useState<T | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const active = useRef<AbortController | null>(null);
  const reviewed = useRef<T | null>(null);
  useEffect(() => () => { active.current?.abort(); reviewed.current = null; }, []);
  function cancel(clear = false) { active.current?.abort(); active.current = null; reviewed.current = null; setBusy(false); if (clear) setValue(null); setError(''); }
  async function run(read: (signal: AbortSignal) => Promise<T>, clear = false) {
    cancel(clear); const controller = new AbortController(); active.current = controller; setBusy(true);
    try { const result = await read(controller.signal); if (!controller.signal.aborted) { reviewed.current = result; setValue(result); return result; } }
    catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Could not load. Try again shortly.'); }
    finally { if (active.current === controller) { active.current = null; setBusy(false); } }
  }
  return { value, error, busy, run, cancel, isCurrent: (value: T) => reviewed.current === value };
}
