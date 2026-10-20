import { useState } from 'react';
import { X } from 'lucide-react';
import SegmentedControl from '../ui/SegmentedControl';
import ChoiceList from '../ui/ChoiceList';
import ShiftRow from './ShiftRow';
import { useWhatIf, type WhatIfLeg } from '../../what-if-client';
import { combineLegs, rankShifts, scenarioHeading } from '../../what-if-model';
import '../../pages/market-detail.css';
import '../../pages/hybrid-analysis.css';

type Member = { id: string; eventIndex: number; question: string; pool: string };
const yesNo = [{ value: 'yes' as const, label: 'Yes' }, { value: 'no' as const, label: 'No' }];
const MAX = 3;

// Assume up to three answers and see how the pool's chance for every other question moves. Read-only: nothing is traded.
export default function WhatIfScenario({ market, markets, initial, onCombine, combineHref, compact = false }: {
  market: { id: string; pool: string; eventIndex: number }; markets: Member[]; initial: WhatIfLeg[];
  onCombine?(legs: WhatIfLeg[]): void; combineHref?(legs: WhatIfLeg[]): string; compact?: boolean;
}) {
  const [given, setGiven] = useState<WhatIfLeg[]>(initial);
  const [adding, setAdding] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const members = markets.filter(item => item.pool.toLowerCase() === market.pool.toLowerCase()).sort((a, b) => a.eventIndex - b.eventIndex);
  const question = (eventIndex: number) => members.find(item => item.eventIndex === eventIndex)?.question ?? `Question ${eventIndex + 1}`;
  const { result, error, loading, refresh } = useWhatIf(market.id, market.pool, given.length ? { given } : null);
  const ranked = result ? rankShifts(result) : null;
  const listed = ranked ? (showAll ? [...ranked.shown, ...ranked.more] : ranked.shown) : [];
  const total = ranked ? ranked.shown.length + ranked.more.length : 0;
  const free = members.filter(item => !given.some(leg => leg.eventIndex === item.eventIndex));
  const sorted = [...given].sort((a, b) => a.eventIndex - b.eventIndex);
  const setSide = (eventIndex: number, side: 'yes' | 'no') => setGiven(old => old.map(leg => leg.eventIndex === eventIndex ? { ...leg, side } : leg));

  return <section className="what-if" aria-label="What if">
    <h2>What if</h2>
    <p className="what-if-intro">{compact ? 'Assume an answer and see how the other chances move.' : 'Assume an answer and see how the pool\'s chances for the other questions move. Read-only.'}</p>
    <ul className="what-if-assumptions" aria-label="Assumptions">
      {sorted.map(leg => <li key={leg.eventIndex} className="what-if-assumption">
        <span className="slip-q">Q{leg.eventIndex + 1}</span>
        <div className="what-if-body"><p className="shift-question">{question(leg.eventIndex)}</p>
          <div className="slip-answer-row">
            <SegmentedControl label={`Assume Q${leg.eventIndex + 1}`} hideLabel value={leg.side} options={yesNo} onChange={side => setSide(leg.eventIndex, side)} block/>
            <button type="button" className="slip-remove" aria-label={`Remove assumption Q${leg.eventIndex + 1}`}
              onClick={() => setGiven(old => old.filter(item => item.eventIndex !== leg.eventIndex))}><X size={15} aria-hidden="true"/></button>
          </div></div>
      </li>)}
    </ul>
    {given.length < MAX && free.length > 0 && <>
      <button type="button" className="slip-toggle" aria-expanded={adding} onClick={() => setAdding(open => !open)}>{adding ? 'Hide the list' : 'Add an assumption'}</button>
      {adding && <ChoiceList label="Add an assumption" value={null} searchable className="combo-add" options={free.map(item => ({ value: item.id, text: item.question,
        label: <><span className="slip-q">Q{item.eventIndex + 1}</span>{' '}{item.question}</> }))}
        onChange={id => { const item = free.find(other => other.id === id); if (item) { setGiven(old => [...old, { eventIndex: item.eventIndex, side: 'yes' }]); setAdding(false); } }}/>}
    </>}
    {given.length >= MAX && <p className="slip-note">Three assumptions is the most. Remove one to add another.</p>}
    {!given.length && <p className="slip-note">Choose an assumption to see how the pool's chances move.</p>}
    {given.length > 0 && loading && !result && <p className="slip-status" role="status">Reading the pool...</p>}
    {given.length > 0 && error && !result && <p className="state-inline error" role="alert">{error} <button type="button" className="text-link" onClick={refresh}>Try again</button></p>}
    {result && ranked && <div className="what-if-results">
      <h3>{scenarioHeading(given)}</h3>
      {result.closed && <p className="slip-note">Trading is closed. These are the pool's final estimates.</p>}
      {ranked.rare ? <p className="slip-note">The pool gives these assumptions less than a one in a billion chance, so it shows no conditional chances.</p>
        : listed.length === 0 ? <p className="slip-note">No other question in this pool has a chance to compare.</p> : <>
          <p className="shift-head" aria-hidden="true"><span>Now</span><span>If assumed</span></p>
          <ol className="shift-list">{listed.map(row => <ShiftRow key={row.eventIndex} number={row.eventIndex + 1} question={question(row.eventIndex)} now={row.yes} assumed={row.givenYes}
            onCombine={onCombine ? () => onCombine(combineLegs(given, row.eventIndex, 'yes', market.eventIndex)) : undefined}
            combineHref={combineHref ? combineHref(combineLegs(given, row.eventIndex, 'yes', market.eventIndex)) : undefined}/>)}</ol>
          {ranked.more.length > 0 && <button type="button" className="slip-toggle" aria-expanded={showAll} onClick={() => setShowAll(open => !open)}>
            {showAll ? 'Show the largest shifts only' : `All ${total} questions`}</button>}
        </>}
      <p className="slip-caption">Pool estimates at block {result.blockNumber}. Assuming an answer does not show that one event causes another.</p>
    </div>}
  </section>;
}
