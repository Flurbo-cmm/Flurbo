import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'wouter';
import { m } from 'framer-motion';
import Price from '../ui/Price';

export type LinkedItem = { key: string; question: string; href: string; yes: string | null };
type Line = { x1: number; y1: number; x2: number; y2: number };
const DRAW = { duration: 0.32, ease: [0.22, 1, 0.36, 1] } as const;

// The other questions priced by the same pool, joined to this one by callout lines like an engraved detail.
export default function LinkedQuestions({ current, items, children }: { current: { yes: string | null }; items: LinkedItem[]; children?: ReactNode }) {
  const host = useRef<HTMLDivElement>(null), node = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<Line[]>([]);
  useLayoutEffect(() => {
    const measure = () => {
      const box = host.current, from = node.current;
      if (!box || !from || window.innerWidth < 768) { setLines([]); return; }
      const origin = box.getBoundingClientRect(), a = from.getBoundingClientRect();
      const x1 = a.right - origin.left, y1 = a.top + a.height / 2 - origin.top;
      setLines([...box.querySelectorAll<HTMLElement>('.linked-row')].flatMap((row) => {
        const r = row.getBoundingClientRect(), x2 = r.left - origin.left;
        return [{ x1, y1, x2, y2: r.top - origin.top }, { x1, y1, x2, y2: r.bottom - origin.top }];
      }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, [items.length]);
  if (!items.length) return null;
  return (
    <div className="linked-questions">
      <div className="linked-diagram" ref={host}>
        <div className="linked-node" ref={node}><p>This question</p><span className="num">Yes <Price atoms={current.yes} fallback="no quote" /></span></div>
        <ul className="linked-list" aria-label="Linked questions in this pool">
          {items.map((item) => <li key={item.key}><Link className="linked-row" href={item.href}><span>{item.question}</span><span className="linked-price"><span className="muted">Yes</span> <Price atoms={item.yes} fallback="Quote" /></span></Link></li>)}
        </ul>
        {lines.length > 0 && <svg className="linked-lines" aria-hidden="true">
          {lines.map((l, i) => <m.line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ ...DRAW, delay: 0.03 * i }} />)}
          {lines.map((l, i) => <rect key={`s${i}`} className="sq" x={l.x2 - 3} y={l.y2 - 3} width={6} height={6} />)}
          <rect className="sq" x={lines[0].x1 - 4} y={lines[0].y1 - 4} width={8} height={8} />
        </svg>}
      </div>
      {children}
    </div>
  );
}
