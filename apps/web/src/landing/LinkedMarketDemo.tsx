import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import JointGrid, { type JointKey, type JointMark } from '../components/market/JointGrid';
import { EXAMPLE, conditionalA, jointCells, type Assumption } from './example-market';

const ASSUMPTIONS: { value: Assumption; label: string }[] = [
  { value: 'none', label: 'No assumption' }, { value: 'yes', label: 'Goes live' }, { value: 'no', label: 'Doesn’t go live' },
];
// The cells counted in the chance of A (focus), the rest of the assumed world (in), and what the assumption rules out.
const MARKS: Record<Assumption, Record<JointKey, JointMark>> = {
  none: { yy: 'focus', yn: 'focus', ny: 'in', nn: 'in' },
  yes: { yy: 'focus', ny: 'in', yn: 'out', nn: 'out' },
  no: { yn: 'focus', nn: 'in', yy: 'out', ny: 'out' },
};
const FORMULA: Record<Assumption, string> = { none: '22 + 18', yes: '22 / 30', no: '(40 - 22) / (100 - 30)' };
const cents = (value: number) => value.toFixed(2);
type Line = { d: string; ends: [number, number][] };

// The example market from the landing page: two linked questions, the joint prices that connect them, and the
// chance of A once B is assumed. Read-only, with illustrative numbers.
export default function LinkedMarketDemo({ proofHref, onProof }: { proofHref: string; onProof(): void }) {
  const [assume, setAssume] = useState<Assumption>('none');
  const cells = jointCells();
  const body = useRef<HTMLDivElement>(null), rowA = useRef<HTMLDivElement>(null), rowB = useRef<HTMLDivElement>(null), grid = useRef<HTMLTableElement>(null);
  const [lines, setLines] = useState<Line[]>([]);
  // Hairline callouts with lime squares join each question to the cells it is priced from, as on an engraved note.
  const draw = useCallback(() => {
    const host = body.current?.getBoundingClientRect(), a = rowA.current?.getBoundingClientRect(), b = rowB.current?.getBoundingClientRect();
    if (!host || !a || !b || !grid.current || window.innerWidth < 640) { setLines([]); return; }
    const at = (x: number, y: number): [number, number] => [Math.round(x - host.left), Math.round(y - host.top)];
    // A meets its own row label; B, once assumed, meets the foot of the column it fixes. No line crosses a price.
    const label = grid.current.querySelector<HTMLElement>('tbody th')!.getBoundingClientRect();
    const start = at(a.right, a.top + a.height / 2), end = at(label.left - 8, label.top + label.height / 2);
    const next: Line[] = [{ d: `M${start[0]} ${start[1]}L${end[0]} ${end[1]}`, ends: [start, end] }];
    if (assume !== 'none') {
      const foot = grid.current.querySelectorAll<HTMLElement>('tbody tr:last-child td')[assume === 'yes' ? 0 : 1].getBoundingClientRect();
      const from = at(b.right, b.top + b.height / 2), to = at(foot.left + foot.width / 2, foot.bottom), elbow = from[0] + 16;
      next.push({ d: `M${from[0]} ${from[1]}H${elbow}V${to[1] + 9}H${to[0]}V${to[1]}`, ends: [from, to] });
    }
    setLines(next);
  }, [assume]);
  useLayoutEffect(draw, [draw]);
  useEffect(() => {
    if (!body.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => draw());
    observer.observe(body.current);
    void document.fonts?.ready.then(() => draw());
    return () => observer.disconnect();
  }, [draw]);
  const chance = conditionalA(assume) * 100;
  return (
    <section className="demo" aria-label="Example market. Illustrative numbers.">
      <div className="demo-head">
        <span>Example market. Illustrative numbers.</span>
        <a className="demo-proof-link" href={proofHref} onClick={onProof}>See the proof</a>
      </div>
      <div className="demo-body" ref={body}>
        <div className="demo-questions">
          <div className="demo-q" ref={rowA}><span className="demo-letter" aria-hidden="true">A</span><p>{EXAMPLE.a}</p><span className="demo-px"><span>Yes</span>{cents(EXAMPLE.pA)}</span></div>
          <div className={`demo-q${assume === 'none' ? '' : ' is-assumed'}`} ref={rowB}><span className="demo-letter" aria-hidden="true">B</span><p>{EXAMPLE.b}</p><span className="demo-px"><span>Yes</span>{cents(EXAMPLE.pB)}</span></div>
        </div>
        <JointGrid ref={grid} caption="Joint prices of A and B" cells={{ yy: cents(cells.yy), yn: cents(cells.yn), ny: cents(cells.ny), nn: cents(cells.nn) }} marks={MARKS[assume]} />
        <svg className="demo-leaders" aria-hidden="true">
          {lines.map((line) => <g key={line.d}><path d={line.d} />{line.ends.map(([x, y]) => <rect key={`${x}:${y}`} x={x - 3.5} y={y - 3.5} width="7" height="7" />)}</g>)}
        </svg>
      </div>
      <div className="demo-controls">
        <div className="demo-assume"><span id="assume-b">Assume B</span>
          <div className="segmented" role="group" aria-labelledby="assume-b">
            {ASSUMPTIONS.map((option) => <button key={option.value} type="button" aria-pressed={assume === option.value} onClick={() => setAssume(option.value)}>{option.label}</button>)}
          </div>
        </div>
        <div className="demo-readout home-example-result" role="status" aria-live="polite">
          <span className="demo-readout-label">Chance of A</span>
          <strong key={assume}>{chance.toFixed(1)}%</strong>
          <span className="demo-formula">{FORMULA[assume]}</span>
        </div>
        <p className="demo-together">A and B together <b>{cents(EXAMPLE.pAB)}</b> vs <b>{cents(EXAMPLE.pA * EXAMPLE.pB)}</b> if independent <span className="demo-pp">+{Math.round((EXAMPLE.pAB - EXAMPLE.pA * EXAMPLE.pB) * 100)} pp</span></p>
        <p className="demo-note">What-if is read-only. A conditional relationship does not establish cause and effect.</p>
      </div>
    </section>
  );
}
