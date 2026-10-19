import { Link } from 'wouter';
import { strongestLinks } from '../../../shared/pool-web.mjs';
import { useWeb } from '../../pool-web-client';
import { signedPercent } from '../../web-layout';

// The Linked tab: a short read of how this question connects to the rest of its pool. The full map lives on its own page.
export default function LinkedSummary({ marketId, pool, event, questions }: { marketId: string; pool: string; event: number; questions: string[] }) {
  const { web, error, retry } = useWeb(marketId);
  const mapHref = `/markets/hybrid/${pool}/web?focus=${event}`;
  const linked = web ? new Set(web.edges.flatMap(edge => [edge.a, edge.b])).size : 0;
  const top = web ? strongestLinks(web, event, 3) : [];
  return <section className="linked-summary" aria-label="Connections">
    <h2>Connections</h2>
    {error ? <p role="alert" className="state-inline error">{error} <button type="button" className="text-link" onClick={retry}>Try again</button></p>
      : !web ? <p role="status" className="market-caption">Reading how this pool links its questions...</p>
      : <>
        <p>{linked === 0 ? `None of the ${web.nodes.length} questions in this pool are priced together yet. Links appear when someone buys a combined prediction.`
          : `${linked} of ${web.nodes.length} questions in this pool are priced together.`}</p>
        {top.length > 0 && <>
          <h3>This question moves most with</h3>
          <ul className="linked-summary-list">{top.map(link => <li key={link.other}>
            <Link href={`/markets/hybrid/${pool}/web?focus=${link.other}`} className="linked-summary-row"><span>{questions[link.other] ?? `Question ${link.other + 1}`}</span>
              <span className="num">{signedPercent(link.difference)}</span></Link></li>)}</ul></>}
      </>}
    <p className="linked-thesis"><Link href={mapHref} className="btn btn-primary">Open connections</Link>
      <Link href={`/markets/hybrid/${pool}/${event}/thesis`} className="btn btn-secondary">Build your thesis</Link></p>
  </section>;
}
