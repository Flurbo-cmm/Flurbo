import { ArrowUpRight } from 'lucide-react';

// What any market publishes about how it settles: the rule, where the answer comes from, the route a result takes,
// and the records anyone can open.
export default function ProofPanel({ id, label, rule, source, route, links }: {
  id?: string; label: string; rule: string; source: string; route: { step: string; detail: string }[]; links: { label: string; href: string }[];
}) {
  return (
    <section id={id} className="proof-panel-card" aria-label={label}>
      <dl className="proof-facts">
        <div><dt>Rule</dt><dd>{rule}</dd></div>
        <div><dt>Source</dt><dd>{source}</dd></div>
      </dl>
      <ol className="proof-route" aria-label="Settlement route">
        {route.map((item) => <li key={item.step}><strong>{item.step}</strong><span>{item.detail}</span></li>)}
      </ol>
      <p className="proof-record">Every live market publishes the same record.</p>
      <ul className="proof-links">
        {links.map((link) => <li key={link.href}><a className="text-link" href={link.href} target="_blank" rel="noreferrer">{link.label} <ArrowUpRight aria-hidden="true" strokeWidth={1.75} /></a></li>)}
      </ul>
    </section>
  );
}
