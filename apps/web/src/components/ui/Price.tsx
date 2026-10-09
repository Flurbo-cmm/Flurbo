import { useEffect, useRef, useState, type ReactNode } from 'react';
import { m } from 'framer-motion';
import { ArrowDown, ArrowUp, Clock } from 'lucide-react';

const ROLL = { duration: 0.26, ease: [0.22, 1, 0.36, 1] } as const;

// Test AUSD has six decimals. Display only: never used for amounts that are signed or paid.
export const atomsToNumber = (atoms: string) => Number(atoms) / 1e6;
export const exactAtoms = (atoms: string) => { const padded = atoms.padStart(7, '0'); return `${padded.slice(0, -6)}.${padded.slice(-6)}`; };
export const formatAtoms = (atoms: string, decimals = 3) => atomsToNumber(atoms).toFixed(decimals);

// A price in test AUSD. Changed digits roll in the direction of the move and a lime line marks the change once.
export default function Price({ atoms, decimals = 3, unit = false, stale = false, staleLabel, fallback = null, className = '' }: {
  atoms: string | null | undefined; decimals?: number; unit?: boolean; stale?: boolean; staleLabel?: string; fallback?: ReactNode; className?: string;
}) {
  const text = atoms != null && /^\d+$/.test(atoms) ? formatAtoms(atoms, decimals) : null;
  const previous = useRef(text);
  const [change, setChange] = useState<{ n: number; up: boolean }>({ n: 0, up: true });
  useEffect(() => {
    const before = previous.current;
    previous.current = text;
    if (before === null || text === null || before === text) return;
    setChange((old) => ({ n: old.n + 1, up: Number(text) > Number(before) }));
  }, [text]);
  if (text === null) return fallback === null ? null : <span className={`price ${className}`.trim()}>{fallback}</span>;
  const rolled = change.n > 0;
  return (
    <span className={`price${stale ? ' price-stale' : ''} ${className}`.trim()} title={`${exactAtoms(atoms!)} test AUSD`}>
      {stale && <Clock aria-hidden="true" strokeWidth={1.75} />}
      {stale && staleLabel && <span className="sr-only">{staleLabel}</span>}
      <span className="price-digits">
        {[...text].map((char, i) => /\d/.test(char)
          ? <span className="price-digit" key={i}><m.span key={`${char}-${rolled ? change.n : 0}`} initial={rolled ? { y: change.up ? '100%' : '-100%', opacity: 0 } : false} animate={{ y: 0, opacity: 1 }} transition={ROLL}>{char}</m.span></span>
          : <span key={i}>{char}</span>)}
      </span>
      {unit && <span className="price-unit">AUSD</span>}
      {rolled && <i className="price-flash-bar" key={change.n} aria-hidden="true" />}
    </span>
  );
}

export function PriceDelta({ atoms }: { atoms: bigint }) {
  const up = atoms > 0n, value = Number(up ? atoms : -atoms) / 1e6;
  return <span className={`delta ${up ? 'delta-up' : 'delta-down'}`} title="Yes price since your last visit">
    {up ? <ArrowUp aria-hidden="true" strokeWidth={2} /> : <ArrowDown aria-hidden="true" strokeWidth={2} />}
    <span className="sr-only">{up ? 'Up' : 'Down'} since your last visit: </span>{up ? '+' : '-'}{value.toFixed(3)}
  </span>;
}
