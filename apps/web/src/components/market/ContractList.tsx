import { useState } from 'react';
import { ArrowUpRight, Check, Copy } from 'lucide-react';

export type ContractRow = { label: string; value: string; href?: string };

// Every address and hash the page already knows, with a copy button and an explorer link. Values wrap; nothing scrolls sideways.
export default function ContractList({ rows, title = 'Contracts and records' }: { rows: ContractRow[]; title?: string }) {
  const [copied, setCopied] = useState('');
  const copy = (value: string) => { void navigator.clipboard?.writeText(value).then(() => { setCopied(value); setTimeout(() => setCopied(''), 1600); }, () => undefined); };
  if (!rows.length) return null;
  return (
    <section className="contract-list" aria-label={title}>
      <h3>{title}</h3>
      <dl>
        {rows.map((row) => <div key={row.label + row.value}>
          <dt>{row.label}</dt>
          <dd><span className="mono-break" title={row.value}>{row.value}</span>
            <span className="contract-actions">
              <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label={`Copy ${row.label}`} onClick={() => copy(row.value)}>{copied === row.value ? <Check aria-hidden="true" strokeWidth={1.75} /> : <Copy aria-hidden="true" strokeWidth={1.75} />}</button>
              {row.href && <a className="btn btn-ghost btn-sm btn-icon" href={row.href} target="_blank" rel="noreferrer" aria-label={`Open ${row.label} in explorer`}><ArrowUpRight aria-hidden="true" strokeWidth={1.75} /></a>}
            </span></dd>
        </div>)}
      </dl>
    </section>
  );
}
