import { storage } from './runtime';
let busy = false;
// Market pending keys are per collection, so practice collections are found by pattern.
export const pendingMarketKey = (key: string) => key === 'flurbo.pilot.pending.v1' || /^flurbo\.practice-[0-9a-f]{40}\.pending\.v1$/.test(key);
export function hasOtherPending(except = '') {
  return [...storage.keys().filter(pendingMarketKey), 'flurbo.mobile.operation.v1'].some(k => k !== except && storage.getItem(k));
}
export function lockOperation() {
  if (busy || hasOtherPending()) throw new Error('Check your pending transaction before starting another action.');
  busy = true;
  return () => { busy = false; };
}
