import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { ArrowUpRight } from 'lucide-react';
import { appFetch } from '../platform-fetch';
import { ApiBase } from '../api-base';
import { useWhatIf, type WhatIfLeg } from '../what-if-client';
import { settlementView } from '../settlement-timeline';
import type { Chances, Side } from '../conditional-view';
import type { ConditionalPool } from '../conditionals-client';
import SegmentedControl from '../components/ui/SegmentedControl';
import WhatIfScenario from '../components/market/WhatIfScenario';
import SettlementSummary, { type SummarySnapshot } from '../components/market/SettlementSummary';
import DecisionView from '../components/conditionals/DecisionView';
import PriceHistory from './PriceHistory';
import './market-detail.css';
import './conditionals.css';
import './demo.css';

// Public, read-only view of listed pools: prices, What if, a combination price, both cases of a conditional and a
// settled Kleros case. No sign-in and no wallet; trading stays on the member pages.
type Question = { id: string; eventIndex: number; question: string; route: string; observationEndsAt: number };
type DemoPool = { pool: string; kind: 'hybrid' | 'conditional'; role: 'live' | 'settled'; title: string; closesAt: number; questions: Question[] };
type Directory = { schema: 'flurbo.demo.v1'; pools: DemoPool[] };

const BASE = '/api/demo';
const percent = (tenths: number | null | undefined) => tenths === null || tenths === undefined ? '...' : `${(tenths / 10).toFixed(1)}%`;
const date = (seconds: number) => new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

async function read<T>(path: string, body?: unknown): Promise<T> {
  const response = await appFetch(`${BASE}${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(value.error || 'The demo could not load. Refresh to try again.');
  return value as T;
}

function useRead<T>(path: string | null, body?: unknown) {
  const key = path === null ? '' : `${path} ${JSON.stringify(body ?? null)}`;
  const [state, setState] = useState<{ key: string; value: T | null; error: string }>({ key: '', value: null, error: '' });
  useEffect(() => {
    if (path === null) return;
    let live = true;
    read<T>(path, body).then(value => { if (live) setState({ key, value, error: '' }); },
      error => { if (live) setState({ key, value: null, error: error instanceof Error ? error.message : 'The demo could not load.' }); });
    return () => { live = false; };
  }, [key]);
  return state.key === key ? state : { key, value: null, error: '' };
}

export default function Demo() {
  const directory = useRead<Directory>('');
  const pools = directory.value?.pools ?? [];
  const live = pools.find(pool => pool.kind === 'hybrid' && pool.role === 'live');
  const conditional = pools.find(pool => pool.kind === 'conditional');
  const settled = pools.find(pool => pool.role === 'settled');
  return <ApiBase.Provider value={BASE}>
    <main id="main" tabIndex={-1} className="market-page demo-page">
      <header className="demo-hero">
        <p className="demo-eyebrow">Live demo · read only</p>
        <h1>Trade how events affect each other.</h1>
        <p className="demo-lede">These are live Flurbo pools on Monad testnet, traded with test funds. Prices, What if and settlement below are read
          straight from the chain. Trading needs an invited account.</p>
        <div className="demo-actions">
          <Link href="/signup" className="btn btn-primary">Request access<ArrowUpRight size={16} strokeWidth={1.75}/></Link>
          <Link href="/docs" className="text-link">Read the guide</Link>
        </div>
      </header>
      {directory.error && <p className="state-inline error" role="alert">{directory.error}</p>}
      {!directory.value && !directory.error && <p role="status" className="busy-text">Reading the pools...</p>}
      {live && <LivePool pool={live}/>}
      {conditional && <ConditionalCase pool={conditional}/>}
      {settled && <SettledCase pool={settled}/>}
    </main>
  </ApiBase.Provider>;
}

function LivePool({ pool }: { pool: DemoPool }) {
  const [selected, setSelected] = useState(0);
  const members = pool.questions.map(item => ({ id: item.id, eventIndex: item.eventIndex, question: item.question, pool: pool.pool }));
  const chosen = members[selected] ?? members[0];
  const { result } = useWhatIf(members[0].id, pool.pool, { given: [{ eventIndex: members[0].eventIndex, side: 'yes' }] });
  const chance = (eventIndex: number) => result?.questions.find(item => item.eventIndex === eventIndex)?.yes ?? null;
  return <section className="demo-section" aria-labelledby="demo-live">
    <div className="demo-section-head">
      <p className="demo-step">1 · One pool, many questions</p>
      <h2 id="demo-live">{pool.title}</h2>
      <p className="market-caption">Every question shares one pool of liquidity. Trading closes {date(pool.closesAt)}.</p>
    </div>
    <ol className="demo-questions">
      {members.map((item, index) => <li key={item.id}>
        <button type="button" className="demo-question" aria-pressed={index === selected} onClick={() => setSelected(index)}>
          <span className="slip-q">Q{item.eventIndex + 1}</span>
          <span className="demo-question-text">{item.question}</span>
          <strong className="demo-chance">{percent(chance(item.eventIndex))}</strong>
        </button>
      </li>)}
    </ol>
    <div className="demo-grid">
      <div className="demo-panel">
        <h3>Price history, Q{chosen.eventIndex + 1}</h3>
        <PriceHistory key={chosen.id} hybridId={chosen.id} event={0} pool={pool.pool} refresh={0}/>
      </div>
      <div className="demo-panel">
        <WhatIfScenario key={chosen.id} market={chosen} markets={members} initial={[{ eventIndex: chosen.eventIndex, side: 'yes' }]} compact/>
      </div>
    </div>
    <Combination pool={pool} members={members}/>
  </section>;
}

function Combination({ pool, members }: { pool: DemoPool; members: { id: string; eventIndex: number; question: string }[] }) {
  const [legs, setLegs] = useState<WhatIfLeg[]>([{ eventIndex: 0, side: 'yes' }, { eventIndex: 1, side: 'yes' }].filter(leg => leg.eventIndex < members.length) as WhatIfLeg[]);
  const input = legs.length >= 2 ? { given: [], claim: { legs, rule: 'AND' as const } } : null;
  const { result, error, loading } = useWhatIf(members[0].id, pool.pool, input);
  const claim = result?.claim ?? null;
  const set = (eventIndex: number, value: 'none' | Side) => setLegs(old => {
    const rest = old.filter(leg => leg.eventIndex !== eventIndex);
    return value === 'none' ? rest : [...rest, { eventIndex, side: value }].sort((a, b) => a.eventIndex - b.eventIndex);
  });
  const sideOf = (eventIndex: number) => legs.find(leg => leg.eventIndex === eventIndex)?.side ?? 'none';
  return <div className="demo-panel demo-combination">
    <h3>Price a combination</h3>
    <p className="market-caption">Pick two or three answers. The pool prices the combination at once, even if nobody has traded it.</p>
    <ul className="demo-legs">
      {members.map(item => {
        const value = sideOf(item.eventIndex), full = legs.length >= 3 && value === 'none';
        return <li key={item.id}>
          <span className="demo-leg-question"><span className="slip-q">Q{item.eventIndex + 1}</span>{item.question}</span>
          <SegmentedControl label={`Answer for question ${item.eventIndex + 1}`} hideLabel value={value} disabled={full}
            options={[{ value: 'none', label: 'Skip' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]}
            onChange={next => set(item.eventIndex, next as 'none' | Side)}/>
        </li>;
      })}
    </ul>
    <div className="demo-claim" aria-live="polite" aria-busy={loading || undefined}>
      {!input ? <p>Choose at least two answers.</p>
        : error ? <p className="state-inline error" role="alert">{error}</p>
        : <dl>
          <div><dt>Chance all of these happen</dt><dd>{percent(claim?.chance)}</dd></div>
          <div><dt>If the questions were unrelated</dt><dd>{percent(claim?.independent)}</dd></div>
          <div><dt>A share pays</dt><dd>1 test AUSD</dd></div>
        </dl>}
    </div>
  </div>;
}

function ConditionalCase({ pool }: { pool: DemoPool }) {
  const detail = useRead<ConditionalPool>(`/conditionals/${pool.pool}`);
  const condition = detail.value?.questions[0];
  const targets = detail.value?.questions.filter(item => item.eventIndex !== condition?.eventIndex) ?? [];
  const [target, setTarget] = useState<number | null>(null);
  const [side, setSide] = useState<Side>('yes');
  const then = target ?? targets[0]?.eventIndex ?? null;
  const asked = condition && then !== null
    ? { condition: [{ eventIndex: condition.eventIndex, side }], target: [{ eventIndex: then, side: 'yes' }] } : null;
  const chances = useRead<{ values: Chances; reasons: Record<string, string> }>(asked ? `/conditionals/${pool.pool}/chances` : null, asked ?? undefined);
  return <section className="demo-section" aria-labelledby="demo-conditional">
    <div className="demo-section-head">
      <p className="demo-step">2 · Conditionals</p>
      <h2 id="demo-conditional">{pool.title}</h2>
      <p className="market-caption">A conditional pays only if its If question happens, and refunds everything, fees included, if it does not.
        The pool shows both cases side by side.</p>
    </div>
    {detail.error && <p className="state-inline error" role="alert">{detail.error}</p>}
    {targets.length > 1 && <SegmentedControl label="Then question" value={String(then)}
      options={targets.map(item => ({ value: String(item.eventIndex), label: `Q${item.eventIndex + 1}` }))}
      onChange={value => setTarget(Number(value))}/>}
    {condition && then !== null && <>
      <p className="demo-then"><span className="slip-q">Q{then + 1}</span>{targets.find(item => item.eventIndex === then)?.question}</p>
      <DecisionView condition={{ eventIndex: condition.eventIndex, side }} target={{ eventIndex: then, side: 'yes' }}
        conditionQuestion={condition.question} values={chances.value?.values ?? null} reasons={chances.value?.reasons ?? {}}
        loading={!chances.value && !chances.error} error={chances.error} onPredict={setSide}/>
    </>}
  </section>;
}

function SettledCase({ pool }: { pool: DemoPool }) {
  const first = pool.questions[0];
  const snapshot = useRead<SummarySnapshot & { closesAt: number; observationEndsAt: number; ruleURI?: string }>(first ? `/hybrid/${first.id}` : null);
  const value = snapshot.value;
  const view = value ? settlementView({ snapshot: value, closesAt: value.closesAt, observationEndsAt: value.observationEndsAt,
    now: Date.now() / 1000, format: date }) : null;
  return <section className="demo-section" aria-labelledby="demo-settled">
    <div className="demo-section-head">
      <p className="demo-step">3 · Settlement and disputes</p>
      <h2 id="demo-settled">{first?.question ?? pool.title}</h2>
      <p className="market-caption">Automatic answers come from a published rule and public data. A challenged answer goes to Kleros, a
        decentralised court, and its ruling is reported back on chain.</p>
    </div>
    {snapshot.error && <p className="state-inline error" role="alert">{snapshot.error}</p>}
    {value && view ? <div className="demo-panel">
      <SettlementSummary snapshot={value} view={view} format={date}/>
      {value.ruleURI && <p><a className="text-link" href={value.ruleURI} target="_blank" rel="noreferrer">Published rule <ArrowUpRight size={14}/></a></p>}
    </div> : !snapshot.error && <p role="status" className="busy-text">Reading the settlement...</p>}
  </section>;
}
