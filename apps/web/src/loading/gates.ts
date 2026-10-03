import { useLayoutEffect, useSyncExternalStore } from 'react';

// Pages report readiness here; the loader host only observes. Registering a gate
// never starts a request, so the loader cannot add reads of its own.
export type GateStatus = 'pending' | 'ready' | 'error';
export type Gate = { id: string; label: string; status: GateStatus; error?: string; retry?: () => void; order: number };

const gates = new Map<string, Gate>();
const completed = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
let order = 0;

function emit() { version += 1; listeners.forEach((listener) => listener()); }
export function subscribeGates(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function gatesVersion() { return version; }

export function setGate(id: string, value: { label: string; status: GateStatus; error?: string; retry?: () => void }) {
  const current = gates.get(id);
  if (current && current.status === value.status && current.label === value.label && current.error === value.error && current.retry === value.retry) return;
  gates.set(id, { id, ...value, order: current?.order ?? ++order });
  emit();
}
export function clearGate(id: string) {
  // Completion belongs to this mounted page, not every future visit to its route.
  completed.delete(id);
  if (gates.delete(id)) emit();
}
export function completeGates(ids: string[]) { ids.forEach((id) => completed.add(id)); emit(); }
export function hasCompleted(id: string) { return completed.has(id); }

/** Gates that still decide whether the branded loader shows. */
export function activeGates(): Gate[] {
  return [...gates.values()].filter((gate) => !completed.has(gate.id)).sort((a, b) => a.order - b.order);
}

/**
 * Each mounted page can use the branded loader for its initial data load.
 * Completion suppresses background refreshes until the page unmounts. The host's
 * show delay still lets fast visits finish without displaying an animation.
 */
export function useLoadGate(id: string, { pending, error, label, retry }: { pending: boolean; error?: string | null; label: string; retry?: () => void }) {
  useSyncExternalStore(subscribeGates, gatesVersion, gatesVersion);
  const status: GateStatus = error ? 'error' : pending ? 'pending' : 'ready';
  useLayoutEffect(() => {
    setGate(id, { label, status, error: error || undefined, retry });
  }, [id, label, status, error, retry]);
  useLayoutEffect(() => () => clearGate(id), [id]);
  return { branded: true, covered: !completed.has(id) };
}
