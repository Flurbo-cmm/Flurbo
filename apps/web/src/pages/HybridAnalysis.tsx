import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { formatUnits, parseUnits } from 'viem';
import { appFetch } from '../platform-fetch';
import { percentageBps, scenarioWins, thesisDistribution, thesisProbability, THESIS_DENOMINATOR } from '../../shared/thesis.mjs';
import { encodeClaim } from '../../shared/claims.mjs';
import type { HybridMarket } from '../market-directory';
import ChoiceList from '../components/ui/ChoiceList';
import SegmentedControl from '../components/ui/SegmentedControl';
import './hybrid-analysis.css';

type Outcome = { a: 'yes' | 'no'; b: 'yes' | 'no'; costAtoms: string | null;
  probability: number | null; scenarioProbability: number | null };
type Analysis = { schema: 'flurbo.hybrid-analysis.v1'; pool: string; a: number; b: number;
  quantity: string; rule: 'AND' | 'OR' | 'EXACTLY_ONE'; closed: boolean; blockNumber: string; blockHash: string; observedAt: number;
  values: { a: number | null; b: number | null; joint: number | null;
    givenYes: number | null; givenNo: number | null; independent: number | null; difference: number | null };
  outcomes: Outcome[]; sensitivity: { answer: 'yes' | 'no'; costAtoms: string | null;
    values: Analysis['values'] | null }[] };

const money = (atoms: string | bigint) => formatUnits(BigInt(atoms), 6);
const pct = (tenths: number | null) => tenths === null ? 'Unavailable' : `${(tenths / 10).toFixed(1)}%`;
const href = (market: HybridMarket) => `/markets/hybrid/${market.pool}/${market.eventIndex}`;

function useAnalysis(market: HybridMarket, other: HybridMarket, quantity: string,
  rule: Analysis['rule'] = 'AND', enabled = true) {
  const [result, setResult] = useState<Analysis | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => { if (!document.hidden) setRevision(n => n + 1); }, 30_000);
    return () => clearInterval(timer);
  }, [enabled]);
  useEffect(() => {
    setResult(null); setError('');
    if (!enabled) { setLoading(false); return; }
    if (!/^[1-9]\d*$/.test(quantity) || BigInt(quantity) > 20_000_000n) { setLoading(false); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      void appFetch(`/api/hybrid/${market.id}/analysis`, { method: 'POST', credentials: 'same-origin',
        cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ a: market.eventIndex, b: other.eventIndex, quantity, rule }),
        signal: controller.signal }).then(async response => {
        if (!response.ok) throw Error('The pool comparison could not load. Refresh to try again.');
        return response.json() as Promise<Analysis>;
      }).then(value => {
        if (controller.signal.aborted) return;
        if (value.schema !== 'flurbo.hybrid-analysis.v1' || value.pool.toLowerCase() !== market.pool.toLowerCase()
          || value.a !== market.eventIndex || value.b !== other.eventIndex
          || value.quantity !== quantity || value.rule !== rule || value.outcomes.length !== 4) throw Error('Invalid pool comparison.');
        setResult(value);
      }).catch(() => { if (!controller.signal.aborted) setError('The pool comparison could not load. Refresh to try again.'); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [market.id, market.eventIndex, other.eventIndex, quantity, rule, enabled, revision]);
  return { result, error, loading, refresh: () => setRevision(n => n + 1) };
}

export function HybridConnections({ market, markets }: { market: HybridMarket; markets: HybridMarket[] }) {
  const others = markets.filter(item => item.pool.toLowerCase() === market.pool.toLowerCase() && item.id !== market.id);
  const [otherId, setOtherId] = useState(others[0]?.id || '');
  const other = others.find(item => item.id === otherId) || others[0];
  if (!other) return null;
  return <HybridComparison market={market} other={other} others={others} onOther={setOtherId}/>;
}

function HybridComparison({ market, other, others, onOther }: { market: HybridMarket; other: HybridMarket;
  others: HybridMarket[]; onOther: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const { result, error, loading, refresh } = useAnalysis(market, other, '1000000', 'AND', expanded);
  return <details className="detail-panel detail-connect hybrid-connect" onToggle={event => setExpanded(event.currentTarget.open)}><summary>Explore how these markets connect</summary>
    <div className="hybrid-analysis-body">
      <div className="hybrid-analysis-head"><div><h3>What if?</h3><p>How does the pool price this question when another answer is assumed?</p></div><span className="chip">Read-only</span></div>
      <ChoiceList label="Suppose this question resolves" value={other.id} options={others.map(item => ({ value: item.id, label: item.question, text: item.question }))} onChange={onOther} className="hybrid-analysis-select"/>
      <button className="btn btn-secondary btn-sm" disabled={loading} onClick={refresh}><RefreshCw size={15}/>Refresh comparison</button>
      {loading && <p role="status">Reading the shared pool...</p>}{error && <p role="alert" className="state-inline error">{error}</p>}
      {result && <>
        <div className="hybrid-conditional"><div><span>{market.question}</span><strong>Yes, without an assumption: {pct(result.values.a)}</strong></div>
          <div><span>If the other answer is Yes</span><strong>{pct(result.values.givenYes)}</strong></div>
          <div><span>If the other answer is No</span><strong>{pct(result.values.givenNo)}</strong></div></div>
        <p>Both Yes: <strong>{pct(result.values.joint)}</strong> in this pool, compared with <strong>{pct(result.values.independent)}</strong> if the answers were independent.</p>
        <div className="hybrid-outcomes"><h4>All four combinations</h4><div>{result.outcomes.map(outcome => <div key={`${outcome.a}-${outcome.b}`}>
          <span>{outcome.a === 'yes' ? 'Yes' : 'No'} + {outcome.b === 'yes' ? 'Yes' : 'No'}</span>
          <strong>{pct(outcome.scenarioProbability)}</strong><small>{outcome.costAtoms === null ? 'Trading closed or quote unavailable' : `${money(outcome.costAtoms)} test AUSD to buy one combined share`}</small>
        </div>)}</div></div>
        {result.sensitivity.length > 0 && <details className="disclosure"><summary>What could one combined trade change?</summary>
          <p>Each example buys one combined share from the same snapshot. Neither trade is placed.</p>
          <div className="hybrid-outcomes"><div>{result.sensitivity.map(scenario => <div key={scenario.answer}>
            <strong>Buy {market.question}: {scenario.answer === 'yes' ? 'Yes' : 'No'} + other: Yes</strong>
            <small>{scenario.costAtoms === null ? 'Quote unavailable' : `${money(scenario.costAtoms)} test AUSD at this snapshot`}</small>
            {scenario.values && <><span>Chance of this question: {pct(result.values.a)} → {pct(scenario.values.a)}</span>
              <span>If other is Yes: {pct(result.values.givenYes)} → {pct(scenario.values.givenYes)}</span></>}
          </div>)}</div></div>
          <p className="market-caption">This holds liquidity and all other trades fixed. It shows model price sensitivity, not evidence that either outcome is more likely.</p>
        </details>}
        <p className="market-caption">Pool estimates reflect pricing state at block {result.blockNumber}. Buy costs include price impact. Conditioning does not show that one event causes the other.</p>
      </>}
      <Link href={`${href(market)}/thesis`} className="btn btn-secondary">Build your thesis</Link>
    </div>
  </details>;
}

export function HybridThesis({ market, markets }: { market: HybridMarket; markets: HybridMarket[] }) {
  const others = markets.filter(item => item.pool.toLowerCase() === market.pool.toLowerCase() && item.id !== market.id);
  const [otherId, setOtherId] = useState(others[0]?.id || '');
  const [sideA, setSideA] = useState<'yes' | 'no'>('yes');
  const [sideB, setSideB] = useState<'yes' | 'no'>('yes');
  const [rule, setRule] = useState<Analysis['rule']>('AND');
  const [shares, setShares] = useState('1');
  const [belief, setBelief] = useState(['', '', '']);
  const other = others.find(item => item.id === otherId) || others[0];
  if (!other) return <main id="main" className="page markets-page"><p>This pool has no second question to compare.</p></main>;
  return <HybridThesisBody market={market} other={other} others={others} onOther={setOtherId}
    sideA={sideA} setSideA={setSideA} sideB={sideB} setSideB={setSideB} rule={rule} setRule={setRule}
    shares={shares} setShares={setShares} belief={belief} setBelief={setBelief}/>;
}

function HybridThesisBody({ market, other, others, onOther, sideA, setSideA, sideB, setSideB, rule, setRule, shares, setShares, belief, setBelief }:
  { market: HybridMarket; other: HybridMarket; others: HybridMarket[]; onOther: (id: string) => void;
    sideA: 'yes' | 'no'; setSideA: (side: 'yes' | 'no') => void; sideB: 'yes' | 'no'; setSideB: (side: 'yes' | 'no') => void;
    rule: Analysis['rule']; setRule: (rule: Analysis['rule']) => void;
    shares: string; setShares: (value: string) => void; belief: string[]; setBelief: (values: string[]) => void }) {
  const validShares = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(shares) && Number(shares) > 0 && Number(shares) <= 20;
  const quantity = validShares ? parseUnits(shares, 6).toString() : '';
  const { result, error, loading, refresh } = useAnalysis(market, other, quantity, rule);
  const bps = belief.map(percentageBps);
  const distribution = bps.every(value => value !== null)
    ? thesisDistribution(bps[0]!, bps[1]!, bps[2]!) : null;
  const selected = result?.outcomes.find(outcome => outcome.a === sideA && outcome.b === sideB);
  const claim = encodeClaim({ events: others.length + 1, rule,
    legs: [{ event: market.eventIndex, yes: sideA === 'yes' },
      { event: other.eventIndex, yes: sideB === 'yes' }] });
  const myChance = distribution ? thesisProbability(distribution, claim, others.length + 1,
    market.eventIndex, other.eventIndex) : null;
  const cost = selected?.costAtoms === null || selected?.costAtoms === undefined ? null : BigInt(selected.costAtoms);
  const expected = myChance === null || quantity === '' ? null : BigInt(quantity) * myChance / THESIS_DENOMINATOR;
  const returnHref = `${href(market)}?answer=${sideA}&other=${other.eventIndex}&otherAnswer=${sideB}&rule=${rule}&shares=${encodeURIComponent(shares)}`;
  return <main id="main" tabIndex={-1} className="page markets-page hybrid-thesis">
    <Link href={href(market)} className="link-back"><ArrowLeft size={18}/>Back to market</Link>
    <header className="hybrid-thesis-heading"><h1>Build your thesis.</h1><p>Put your view into numbers and compare it with the shared pool. No trade or estimate is saved here.</p></header>
    <div className="hybrid-thesis-grid"><section className="detail-panel"><h2>Your view</h2>
      <p>Question A: {market.question}</p>
      <ChoiceList label="Question B" value={other.id} options={others.map(item => ({ value: item.id, label: item.question, text: item.question }))} onChange={onOther} className="hybrid-analysis-select"/>
      {['Chance A is Yes', 'Chance B is Yes if A is Yes', 'Chance B is Yes if A is No'].map((label, i) =>
        <label className="hybrid-belief" key={label}>{label}<span><input inputMode="decimal" value={belief[i]}
          onChange={event => setBelief(belief.map((value, index) => index === i ? event.target.value : value))}
          aria-invalid={belief[i] !== '' && bps[i] === null} placeholder="Your estimate"/>%</span></label>)}
      <p className="market-caption">These are your estimates, not facts supplied by the pool. The three numbers determine the four joint outcomes.</p>
    </section><section className="detail-panel"><h2>Prediction to compare</h2>
      <div className="hybrid-thesis-answers"><SegmentedControl label="A resolves" value={sideA} options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} onChange={value => setSideA(value as 'yes' | 'no')} block/>
        <SegmentedControl label="B resolves" value={sideB} options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} onChange={value => setSideB(value as 'yes' | 'no')} block/></div>
      <SegmentedControl label="Payout rule" value={rule} options={[{ value: 'AND', label: 'Both (AND)' }, { value: 'OR', label: 'At least one (OR)' }, { value: 'EXACTLY_ONE', label: 'Exactly one' }]} onChange={value => setRule(value as Analysis['rule'])} block/>
      <label className="hybrid-belief">Shares<input inputMode="decimal" value={shares} onChange={event => setShares(event.target.value)} aria-invalid={!validShares}/></label>
      <button className="btn btn-secondary btn-sm" disabled={loading} onClick={refresh}><RefreshCw size={15}/>Refresh pool</button>
      {loading && <p role="status">Reading pool prices...</p>}{error && <p role="alert" className="state-inline error">{error}</p>}
      {result && <><div className="hybrid-outcomes"><h3>Four possible outcomes</h3><div>{result.outcomes.map(outcome => {
        const index = (outcome.a === 'yes' ? 1 : 0) + (outcome.b === 'yes' ? 2 : 0);
        return <div key={`${outcome.a}-${outcome.b}`} className={outcome === selected ? 'selected' : ''}>
          <span>A {outcome.a} · B {outcome.b}</span><strong>Pool {pct(outcome.scenarioProbability)}</strong>
          <small>Your chance {distribution ? `${(Number(distribution[index]) / 1_000_000).toFixed(2)}%` : 'not entered'} · Your position {scenarioWins(claim, others.length + 1, market.eventIndex, other.eventIndex, index) ? 'pays' : 'loses'}</small>
        </div>;
      })}</div></div>
        <dl className="review-figures"><div className="review-cost"><dt>Current quote for this combination</dt><dd>{cost === null ? 'Unavailable' : `${money(cost)} test AUSD`}</dd></div>
          <div><dt>Pool chance of this position paying</dt><dd>{pct(selected?.probability ?? null)}</dd></div>
          <div><dt>Gross payout if it pays</dt><dd>{shares} test AUSD</dd></div>
          <div><dt>Net if either answer differs</dt><dd>{cost === null ? 'Unavailable' : `−${money(cost)} test AUSD`}</dd></div>
          <div><dt>Your expected net at this quote</dt><dd>{expected === null || cost === null ? 'Enter your estimates' : `${expected - cost >= 0n ? '+' : ''}${money(expected - cost)} test AUSD`}</dd></div></dl>
        <p className="market-caption">Expected net uses your estimates, the current buy quote and the binary payout. Gas and any VOID result are excluded. The market ticket checks a fresh quote before you sign.</p>
        {!result.closed && cost !== null && distribution && validShares
          ? <Link href={returnHref} className="btn btn-primary">Review this prediction</Link>
          : <p role="status">{result.closed ? 'Trading is closed. You can still explore outcomes.'
            : cost === null ? 'No current quote is available for this size.' : 'Enter valid estimates and a share amount to continue.'}</p>}
        <p className="market-caption">Pool state read at block {result.blockNumber}. Pool probabilities are model estimates, not independent evidence about the event.</p>
      </>}
    </section></div>
  </main>;
}
