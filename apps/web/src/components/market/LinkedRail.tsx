import { useLayoutEffect, useState, type RefObject } from 'react';
import { m } from 'framer-motion';

type Segment = { y: number; xs: number[]; right: number };
const DRAW = { duration: 0.24, ease: [0.22, 1, 0.36, 1] } as const;

// Questions from the same pool share a bracket rail drawn in the gutter above them, with lime squares where it meets
// each tile. Drawn for the pool under the pointer or keyboard focus, from the tiles' measured positions.
export default function LinkedRail({ host, group, version }: { host: RefObject<HTMLElement | null>; group: string | null; version: string }) {
  const [segments, setSegments] = useState<Segment[]>([]);
  useLayoutEffect(() => {
    const node = host.current;
    if (!node || !group) { setSegments([]); return; }
    const tiles = [...node.querySelectorAll<HTMLElement>('.market-card')].filter((tile) => tile.dataset.group === group);
    if (tiles.length < 2) { setSegments([]); return; }
    const origin = node.getBoundingClientRect(), rows = new Map<number, DOMRect[]>();
    for (const tile of tiles) { const r = tile.getBoundingClientRect(), key = Math.round(r.top); rows.set(key, [...(rows.get(key) ?? []), r]); }
    setSegments([...rows.values()].map((list) => ({ y: list[0].top - origin.top - 6, xs: list.map((r) => r.left - origin.left + 18), right: list[list.length - 1].right - origin.left - 18 })));
  }, [host, group, version]);
  if (!segments.length) return null;
  return (
    <svg className="linked-rail" aria-hidden="true">
      {segments.map((s, i) => <g key={`${group}-${i}`}>
        <m.path d={`M${s.xs[0]} ${s.y}H${s.right}`} initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={DRAW} />
        {[...s.xs, s.right].map((x) => <path key={x} d={`M${x} ${s.y}V${s.y + 6}`} />)}
        {s.xs.map((x, j) => <m.rect key={x} className="rail-square" x={x - 3} y={s.y - 3} width={6} height={6} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ ...DRAW, delay: 0.04 * j }} />)}
      </g>)}
    </svg>
  );
}
