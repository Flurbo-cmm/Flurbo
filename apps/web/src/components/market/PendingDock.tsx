import { useEffect, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { m } from 'framer-motion';
import { readHybridPending, readOraclePending } from '../../pending-readers';

type Tracked = { href: string; waiting: boolean };

// Reads the transactions the market pages are tracking so one stays in view on every page. Never writes or clears them.
function readTracked(): Tracked[] {
  const found: Tracked[] = [];
  const oracle = readOraclePending();
  if (oracle) found.push({ href: `/markets/oracle/${oracle.market}`, waiting: false });
  const hybrid = readHybridPending();
  const hybridId = hybrid?.id.match(/^(0x[0-9a-f]{40})-(\d{1,2})$/i);
  if (hybrid && hybridId) found.push({ href: `/markets/hybrid/${hybridId[1]}/${Number(hybridId[2])}`, waiting: hybrid.hash === null });
  return found;
}

export default function PendingDock() {
  const [location] = useLocation();
  const [tracked, setTracked] = useState<Tracked[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    setTracked(readTracked());
  }, [location, tick]);
  useEffect(() => {
    const refresh = () => setTick((n) => n + 1);
    window.addEventListener('storage', refresh);
    window.addEventListener('flurbo:pending', refresh);
    const timer = setInterval(() => { if (!document.hidden) refresh(); }, 5000);
    return () => { window.removeEventListener('storage', refresh); window.removeEventListener('flurbo:pending', refresh); clearInterval(timer); };
  }, []);
  if (!tracked.length) return null;
  const first = tracked[0];
  return (
    <m.aside className="pending-dock" aria-label="Pending transaction status" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}>
      <i aria-hidden="true" />
      <span role="status">{tracked.length === 1 ? (first.waiting ? '1 transaction waiting for your wallet' : '1 transaction pending') : `${tracked.length} transactions pending`}</span>
      {location !== first.href.split('?')[0] && <Link href={first.href} className="text-link">View</Link>}
    </m.aside>
  );
}
