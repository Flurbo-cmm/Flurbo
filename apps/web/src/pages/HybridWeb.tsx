import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Link } from 'wouter';
import { ArrowLeft, RefreshCw, X } from 'lucide-react';
import { useWeb } from '../pool-web-client';
import { shortTime } from '../format';
import type { HybridMarket } from '../market-directory';
import { strongestLinks, type PoolWebEdge } from '../../shared/pool-web.mjs';
import { ringLayout, shortTitle, signedPercent } from '../web-layout';
import { WhatIfPanel } from './HybridAnalysis';
import './hybrid-web.css';

type Selection = { kind: 'node'; event: number } | { kind: 'edge'; a: number; b: number } | null;

const SIZE = 560, WIDTH = 1120, SHIFT = (WIDTH - SIZE) / 2;
const percent = (tenths: number | null) => tenths === null ? 'No price' : `${(tenths / 10).toFixed(1)}%`;

function useNarrow() {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)'), update = () => setNarrow(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return narrow;
}

export default function HybridWeb({ poolId, markets, focus }: { poolId: string; markets: HybridMarket[]; focus: number | null }) {
  const members = useMemo(() => markets.filter(item => item.pool.toLowerCase() === poolId.toLowerCase())
    .sort((a, b) => a.eventIndex - b.eventIndex), [markets, poolId]);
  const first = members[0];
  const { web, error, retry } = useWeb(first?.id ?? '');
  const narrow = useNarrow();
  const [selection, setSelection] = useState<Selection>(
    focus !== null && members.some(item => item.eventIndex === focus) ? { kind: 'node', event: focus } : null);
  const [hover, setHover] = useState<number | null>(null);
  const linkedEvents = useMemo(() => new Set(web?.edges.flatMap(edge => [edge.a, edge.b]) ?? []), [web]);
  const layout = useMemo(() => new Map(web ? ringLayout(web.nodes.map(node => ({ event: node.event, linked: linkedEvents.has(node.event) })), SIZE)
    .map(point => [point.event, point] as const) : []), [web, linkedEvents]);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') setSelection(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (!first) return <main id="main" tabIndex={-1} className="page page-task"><div className="state-block"><h1>Pool not found</h1>
    <Link href="/markets" className="btn btn-primary">All markets</Link></div></main>;

  const byEvent = (event: number) => members.find(item => item.eventIndex === event);
  const nameOf = (event: number) => `Question ${event + 1}`;
  const labelFor = (event: number) => web?.questions[event] ?? byEvent(event)?.question ?? nameOf(event);
  const back = `/markets/hybrid/${first.pool}/${focus !== null && byEvent(focus) ? focus : first.eventIndex}`;
  const activeEvent = hover ?? (selection?.kind === 'node' ? selection.event : null);
  const touches = (edge: PoolWebEdge) => activeEvent === null || edge.a === activeEvent || edge.b === activeEvent;
  const selectedEdge = web && selection?.kind === 'edge' ? web.edges.find(edge => edge.a === selection.a && edge.b === selection.b) : undefined;
  const linkCount = (event: number) => web?.edges.filter(edge => edge.a === event || edge.b === event).length ?? 0;
  const ranked = web ? [...web.edges].sort((a, b) => Math.abs(b.difference ?? 0) - Math.abs(a.difference ?? 0) || a.a - b.a || a.b - b.b) : [];
  const dense = (web?.nodes.length ?? 0) > 16;

  const step = (event: number, direction: 1 | -1) => {
    if (!web) return;
    const peers = [...new Set(web.edges.flatMap(edge => edge.a === event ? [edge.b] : edge.b === event ? [edge.a] : []))].sort((a, b) => a - b);
    if (!peers.length) return;
    const next = direction === 1 ? peers.find(p => p > event) ?? peers[0] : [...peers].reverse().find(p => p < event) ?? peers[peers.length - 1];
    document.getElementById(`web-node-${next}`)?.focus();
  };
  const onNodeKey = (event: KeyboardEvent, node: number) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelection({ kind: 'node', event: node }); }
    else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); step(node, 1); }
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); step(node, -1); }
  };
  const linkRow = (edge: PoolWebEdge, from: number) => <li key={`${edge.a}-${edge.b}`}>
    <button type="button" className="web-link-row" onClick={() => setSelection({ kind: 'edge', a: edge.a, b: edge.b })}>
      <span>{labelFor(edge.a === from ? edge.b : edge.a)}</span><span className="num">{signedPercent(edge.difference)}</span></button></li>;

  let panel;
  if (!web) panel = <p className="market-caption">Reading the pool.</p>;
  else if (selectedEdge) {
    const a = byEvent(selectedEdge.a), b = byEvent(selectedEdge.b);
    panel = <>
      <button type="button" className="web-clear" onClick={() => setSelection({ kind: 'node', event: selectedEdge.a })}><ArrowLeft size={16}/>{nameOf(selectedEdge.a)}</button>
      <h2 className="web-panel-title">{labelFor(selectedEdge.a)}</h2>
      <p className="web-versus">and {labelFor(selectedEdge.b)}</p>
      {a && b && <WhatIfPanel key={`${a.id}-${b.id}`} market={a} other={b} fallback={selectedEdge.joint === null ? null
        : `This pool prices both Yes at ${percent(selectedEdge.joint)}, against ${percent(selectedEdge.independent)} if the two were independent.`}/>}
    </>;
  } else if (selection?.kind === 'node') {
    const market = byEvent(selection.event), node = web.nodes[selection.event];
    const all = web.edges.filter(edge => edge.a === selection.event || edge.b === selection.event);
    panel = <>
      <button type="button" className="web-clear is-node" onClick={() => setSelection(null)}><X size={16}/>Clear</button>
      <h2 className="web-panel-title">{labelFor(selection.event)}</h2>
      <p className="web-versus">Yes <strong className="num">{percent(node?.yes ?? null)}</strong></p>
      {all.length === 0 ? <p>This question is in the same pool but is not priced together with another one yet.</p> : <>
        <h3>Moves most with</h3>
        <ul className="web-links">{strongestLinks(web, selection.event, 3).map(link => linkRow(link.edge, selection.event))}</ul>
        {all.length > 3 && <details className="disclosure"><summary>All {all.length} links</summary>
          <ul className="web-links">{all.map(edge => linkRow(edge, selection.event))}</ul></details>}
        <p className="market-caption">The percent is how far the pool's chance of both Yes sits from the chance if the two were independent. A plus sign means they tend to move together, a minus sign against each other.</p></>}
      {market && <Link href={`/markets/hybrid/${market.pool}/${market.eventIndex}`} className="btn btn-primary">Open this market</Link>}
    </>;
  } else panel = <>
    <h2 className="web-panel-title">{web.title}</h2>
    <dl className="web-facts"><div><dt>Questions</dt><dd className="num">{web.nodes.length}</dd></div>
      <div><dt>Priced together</dt><dd className="num">{linkedEvents.size}</dd></div>
      <div><dt>Links</dt><dd className="num">{web.edges.length}</dd></div>
      <div><dt>Closes</dt><dd>{shortTime(web.closesAt)}</dd></div></dl>
    {web.edges.length === 0
      ? <p>No questions in this pool are priced together yet. Links appear when someone buys a combined prediction.</p>
      : <p>Select a question to see what it moves with, or a line to see what changes when one answer is assumed.</p>}
    <p className="market-caption">Read at block {web.blockNumber}.{web.estimated ? ' Link strengths are estimates from the pool state.' : ''}</p>
  </>;

  return <main id="main" tabIndex={-1} className="page markets-page hybrid-web">
    <nav className="market-topbar" aria-label="Breadcrumb"><Link href={back} className="link-back"><ArrowLeft aria-hidden="true" strokeWidth={1.75}/>Back to market</Link></nav>
    <header className="hybrid-web-heading"><h1>How these questions connect.</h1>
      <p>{first.poolTitle}. Two questions are connected when the pool prices them together.</p></header>
    {error && <div className="state-block" role="alert"><h2>Connections did not load</h2><p>{error}</p>
      <button type="button" className="btn btn-primary" onClick={retry}><RefreshCw size={15}/>Try again</button></div>}
    {!error && !web && <p role="status" className="busy-text">Reading the pool...</p>}
    {web && <div className={`hybrid-web-grid${selection ? ' has-selection' : ''}`}>
      <section aria-label="Connections" className="hybrid-web-stage">
        {narrow ? <ol className="web-list">
          {ranked.map(edge => <li key={`${edge.a}-${edge.b}`}><button type="button" className="web-list-edge" onClick={() => setSelection({ kind: 'edge', a: edge.a, b: edge.b })}>
            <span>{labelFor(edge.a)}</span><span>{labelFor(edge.b)}</span><strong className="num">{signedPercent(edge.difference)}</strong></button></li>)}
          {web.nodes.filter(node => !linkedEvents.has(node.event)).map(node => <li key={node.event}><button type="button" className="web-list-edge is-plain" onClick={() => setSelection({ kind: 'node', event: node.event })}>
            <span>{labelFor(node.event)}</span><span className="market-caption">Same pool, not priced together yet</span></button></li>)}
        </ol> : <svg viewBox={`0 0 ${WIDTH} ${SIZE}`} className="web-svg" role="group" aria-label="Map of connected questions">
          <circle className="web-ring" cx={SHIFT + SIZE / 2} cy={SIZE / 2} r={SIZE * 0.43}/>
          {web.edges.map(edge => {
            const p = layout.get(edge.a), q = layout.get(edge.b);
            if (!p || !q) return null;
            const weight = 1 + Math.min(5, Math.abs(edge.difference ?? 0) / 20);
            const chosen = selection?.kind === 'edge' && selection.a === edge.a && selection.b === edge.b;
            return <g key={`${edge.a}-${edge.b}`} className={`web-edge${touches(edge) ? '' : ' is-dim'}${chosen ? ' is-chosen' : ''}`}>
              <line x1={SHIFT + p.x} y1={p.y} x2={SHIFT + q.x} y2={q.y} strokeWidth={weight} strokeDasharray={(edge.difference ?? 0) < 0 ? '6 5' : undefined}/>
              <line className="web-hit" x1={SHIFT + p.x} y1={p.y} x2={SHIFT + q.x} y2={q.y}
                onClick={() => setSelection({ kind: 'edge', a: edge.a, b: edge.b })}>
                <title>{`${nameOf(edge.a)} and ${nameOf(edge.b)}: ${signedPercent(edge.difference)}`}</title></line>
            </g>;
          })}
          {web.nodes.map(node => {
            const point = layout.get(node.event);
            if (!point) return null;
            const x = SHIFT + point.x, y = point.y, linked = linkedEvents.has(node.event);
            const chosen = selection?.kind === 'node' && selection.event === node.event, active = chosen || activeEvent === node.event;
            const side = point.x > SIZE / 2 + 8 ? 'right' : point.x < SIZE / 2 - 8 ? 'left' : 'middle';
            const anchor = side === 'left' ? 'end' : side === 'right' ? 'start' : 'middle';
            const dx = side === 'left' ? -16 : side === 'right' ? 16 : 0, dy = side === 'middle' ? (y < SIZE / 2 ? -16 : 28) : 6;
            const full = active || (!linked && !dense);
            return <g key={node.event} id={`web-node-${node.event}`} tabIndex={0} role="button" className={`web-node${linked ? ' is-linked' : ''}${chosen ? ' is-chosen' : ''}`}
              aria-label={`${nameOf(node.event)}: ${labelFor(node.event)}, Yes ${percent(node.yes)}, linked to ${linkCount(node.event)} ${linkCount(node.event) === 1 ? 'question' : 'questions'}`}
              aria-pressed={chosen} onClick={() => setSelection({ kind: 'node', event: node.event })} onKeyDown={event => onNodeKey(event, node.event)}
              onMouseEnter={() => setHover(node.event)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(node.event)} onBlur={() => setHover(null)}>
              <rect className="web-hit-node" x={x - 14} y={y - 14} width={28} height={28}/>
              <rect className="web-square" x={x - 5} y={y - 5} width={10} height={10}/>
              <text className="web-label" x={x + dx} y={y + dy} textAnchor={anchor}>{full ? `Q${node.event + 1} ${shortTitle(labelFor(node.event), 4, 24)}` : `Q${node.event + 1}`}</text>
              <title>{labelFor(node.event)}</title>
            </g>;
          })}
        </svg>}
        {!narrow && web.edges.length === 0 && <p className="web-empty">No questions in this pool are priced together yet. Links appear when someone buys a combined prediction.</p>}
        <ul className="web-key" aria-label="How to read the map">
          <li><svg width="28" height="8" aria-hidden="true"><line x1="0" y1="4" x2="28" y2="4"/></svg>Tend to move together</li>
          <li><svg width="28" height="8" aria-hidden="true"><line x1="0" y1="4" x2="28" y2="4" strokeDasharray="6 5"/></svg>Tend to move against each other</li>
          <li><svg width="10" height="10" aria-hidden="true"><rect className="web-square" x="1" y="1" width="8" height="8"/></svg>Outer ring: same pool, not priced together yet</li></ul>
      </section>
      <aside className="detail-panel hybrid-web-panel" aria-label="Details" aria-live="polite">
        {narrow && selection && <button type="button" className="web-sheet-close" onClick={() => setSelection(null)}><X size={16}/>Close</button>}
        {panel}
      </aside>
    </div>}
  </main>;
}
