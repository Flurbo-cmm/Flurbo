import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import PageHeader from '../PageHeader';
import { compactRelative, exactTime } from '../../format';
import { useLoadGate } from '../../loading/gates';
import { CONDITIONAL_COPY } from '../../conditional-view';
import { loadDirectory, type ConditionalDirectory as Directory } from '../../conditionals-client';

// Every conditional pool, each listing its questions in full. A pool opens its If and Then page.
export default function ConditionalDirectory() {
  const [directory, setDirectory] = useState<Directory | null>(null);
  const [error, setError] = useState(''), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setError('');
    loadDirectory().then(value => { if (live) setDirectory(value); },
      (e: Error & { status?: number }) => { if (live) setError(e.status === 503 ? CONDITIONAL_COPY.unavailable : e.message); });
    return () => { live = false; };
  }, [attempt]);
  const gate = useLoadGate('conditionals', { pending: !directory && !error, label: 'Loading conditional pools' });
  const now = Date.now() / 1000;
  return <main id="main" tabIndex={-1} className="page conditionals-page cond-directory" aria-busy={!directory && !error}>
    <PageHeader title={CONDITIONAL_COPY.title} lead={CONDITIONAL_COPY.lead} />
    <section className="cond-explainer" aria-label="How a conditional pays">
      <h2>How a conditional pays</h2>
      <p className="cond-explainer-sentence">{CONDITIONAL_COPY.explain}</p>
      <ul className="cond-payoffs-plain">
        <li data-key="both"><span className="cond-payoff-mark" aria-hidden="true" />Both happen: each share pays 1 test AUSD.</li>
        <li data-key="conditionOnly"><span className="cond-payoff-mark" aria-hidden="true" />The If answer happens and the Then answer does not: it pays nothing.</li>
        <li data-key="refund"><span className="cond-payoff-mark" aria-hidden="true" />The If answer does not happen: you get back what you paid.</li>
      </ul>
    </section>
    {error ? <div className="state-block" role="alert"><h2>Conditional pools could not load</h2><p>{error}</p>
      <button type="button" className="btn btn-primary" onClick={() => setAttempt(value => value + 1)}>Retry</button></div>
      : !directory ? <>{!gate.covered && <span className="progress-line" aria-hidden="true" />}<p role="status" className={gate.covered ? 'sr-only' : 'busy-text'}>Loading conditional pools...</p></>
      : !directory.pools.length ? <div className="state-block"><h2>No conditional pools yet</h2><p>{CONDITIONAL_COPY.empty}</p>
        <Link href="/markets" className="btn btn-secondary">Browse markets</Link></div>
      : <ul className="cond-pool-list" aria-label="Conditional pools">
        {directory.pools.map(pool => <li key={pool.pool} className="cond-pool">
          <div className="cond-pool-head">
            <h2><Link href={`/conditionals/${pool.pool}`}>{pool.title}</Link></h2>
            <p className="cond-pool-meta"><span>{pool.questions.length} questions</span>
              <span title={exactTime(pool.closesAt)}>{pool.closesAt <= now ? `Closed ${compactRelative(pool.closesAt, now)}` : `Closes ${compactRelative(pool.closesAt, now)}`}</span></p>
          </div>
          <ol className="cond-pool-questions">{pool.questions.map((question, i) => <li key={i}><span className="slip-q">Q{i + 1}</span><span>{question}</span></li>)}</ol>
          <Link href={`/conditionals/${pool.pool}`} className="btn btn-secondary btn-sm cond-pool-open" aria-label={`Open ${pool.title}`}>Choose If and Then</Link>
        </li>)}
      </ul>}
  </main>;
}
