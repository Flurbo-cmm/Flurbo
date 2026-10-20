import { Link } from 'wouter';
import { shiftText } from '../../what-if-model';

const pct = (tenths: number) => (tenths / 10).toFixed(1);
const X0 = 6, X1 = 114;
const at = (tenths: number) => X0 + Math.min(1000, Math.max(0, tenths)) / 1000 * (X1 - X0);

// One question's chance now and under the assumptions: a hollow square for now, a lime square for the assumed chance
// (what holds if the assumptions hold), joined by an ink line on a hairline track.
export default function ShiftRow({ number, question, now, assumed, onCombine, combineHref }: {
  number: number; question: string; now: number; assumed: number; onCombine?(): void; combineHref?: string;
}) {
  const shift = assumed - now;
  const direction = shift > 0 ? `up ${pct(shift)} points` : shift < 0 ? `down ${pct(-shift)} points` : 'unchanged';
  const label = `Q${number} ${pct(now)} percent now, ${pct(assumed)} percent if assumed, ${direction}`;
  const from = at(now), to = at(assumed);
  return <li className="shift-row">
    <span className="slip-q">Q{number}</span>
    <p className="shift-question">{question}</p>
    <div className="shift-figures">
      <span className="num">{pct(now)}%</span>
      <svg className="shift-track" width="120" height="12" viewBox="0 0 120 12" role="img" aria-label={label}>
        <line className="shift-rail" x1={X0} y1="6" x2={X1} y2="6"/>
        <line className="shift-link" x1={from} y1="6" x2={to} y2="6"/>
        <rect className="shift-now" x={from - 4} y="2" width="8" height="8"/>
        <rect className="shift-then" x={to - 4} y="2" width="8" height="8"/>
      </svg>
      <span className="num">{pct(assumed)}%</span>
      <strong className="shift-delta num">{shiftText(shift)}</strong>
    </div>
    {combineHref ? <Link href={combineHref} className="btn btn-secondary btn-sm" aria-label={`Combine with Q${number}`}>Combine</Link>
      : onCombine && <button type="button" className="btn btn-secondary btn-sm" aria-label={`Combine with Q${number}`} onClick={onCombine}>Combine</button>}
  </li>;
}
