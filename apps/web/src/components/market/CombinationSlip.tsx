import { Fragment, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import SegmentedControl from '../ui/SegmentedControl';
import ChoiceList from '../ui/ChoiceList';
import OutcomeMap from './OutcomeMap';
import { addExtra, legCount, removeExtra, suggestedLinks, type ComboState } from '../../combo-picker-model';
import { RULE_OPTIONS, payoutSentence, ruleWord, type Rule } from '../../ticket-copy';
import { signedPoints } from '../../web-layout';
import type { WhatIf } from '../../what-if-client';

type Other = { id: string; eventIndex: number; question: string };
const yesNo = [{ value: 'yes' as const, label: 'Yes' }, { value: 'no' as const, label: 'No' }];
const pct = (tenths: number | null) => tenths === null ? 'Unavailable' : `${(tenths / 10).toFixed(1)}%`;
const countWord = (count: number) => count === 2 ? 'Two' : 'Three';

// The prediction as a slip of one to three linked answers. This question is always the first line; the pool's strongest
// links are one tap away, and everything the pool can say about the combination sits beside the rule that picks it.
export default function CombinationSlip({ mode = 'buy', anchor, side, onSide, others, value, onChange, rule, onRule, links, whatIf, whatIfError, whatIfLoading = false,
  disabled = false, focusRequest = null, findOpen = false, addRef }: {
  mode?: 'buy' | 'sell'; anchor: { eventIndex: number; question: string }; side: 'yes' | 'no'; onSide(side: 'yes' | 'no'): void;
  others: Other[]; value: ComboState; onChange(next: ComboState): void; rule: Rule; onRule(rule: Rule): void;
  links: { other: number; difference: number | null }[] | null; whatIf: WhatIf | null; whatIfError: string; whatIfLoading?: boolean;
  disabled?: boolean; focusRequest?: { event: number; id: number } | null; findOpen?: boolean; addRef?: React.Ref<HTMLHeadingElement>;
}) {
  const root = useRef<HTMLDivElement>(null);
  const focusEvent = useRef<number | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [announce, setAnnounce] = useState('');
  const count = legCount(value);
  const chosen = ([[value.extra1, value.extra1Side, 1], [value.extra2, value.extra2Side, 2]] as const)
    .flatMap(([id, answer, slot]) => { const item = id ? others.find(other => other.id === id) : undefined; return item ? [{ ...item, answer, slot }] : []; });
  const legs = [{ eventIndex: anchor.eventIndex, question: anchor.question, answer: side, slot: 0 as 0 | 1 | 2, id: 'anchor' }, ...chosen];
  const addable = whatIf?.claim?.addable ?? null;
  const suggestions = suggestedLinks(links ?? [], value, others, addable);
  const remaining = others.filter(item => item.id !== value.extra1 && item.id !== value.extra2);
  const pickable = addable ? remaining.filter(item => addable.includes(item.eventIndex)) : remaining;
  const noLinks = links !== null && links.length === 0;
  const strength = (eventIndex: number) => links?.find(link => link.other === eventIndex)?.difference;

  useEffect(() => { if (focusRequest) focusEvent.current = focusRequest.event; }, [focusRequest?.id]);
  useEffect(() => {
    if (focusEvent.current === null) return;
    const target = root.current?.querySelector<HTMLElement>(`.slip-leg[data-event="${focusEvent.current}"] [role="radio"][aria-checked="true"]`);
    if (!target) return;
    focusEvent.current = null;
    target.focus({ preventScroll: true });
  });

  const add = (id: string) => {
    const item = others.find(other => other.id === id);
    if (!item || count >= 3) return;
    focusEvent.current = item.eventIndex;
    setListOpen(false);
    setAnnounce(`Added Q${item.eventIndex + 1}. ${countWord(count + 1)} questions in this prediction.`);
    onChange(addExtra(value, id));
  };
  const remove = (slot: 1 | 2, eventIndex: number) => {
    focusEvent.current = anchor.eventIndex;
    setAnnounce(`Removed Q${eventIndex + 1}.`);
    onChange(removeExtra(value, slot));
  };

  const sortedLegs = legs.map(leg => ({ number: leg.eventIndex + 1, side: leg.answer })).sort((a, b) => a.number - b.number);
  const claim = whatIf?.claim ?? null;
  const addArea = count >= 3
    ? <p className="slip-note">Three questions is the most one prediction can combine. Remove one to add another.</p>
    : <div className="slip-add" role="group" aria-labelledby="slip-add-title">
      <div className="slip-add-head"><h3 id="slip-add-title" ref={addRef} tabIndex={-1} data-slip-add="true">Add a linked question</h3>
        <span className="slip-hint">{count === 1 ? 'Up to two more can join' : 'One more can join'}</span></div>
      {links === null && <p className="slip-status" role="status">Reading how this pool links its questions...</p>}
      {suggestions.map(item => <button type="button" key={item.id} className="slip-suggestion" disabled={disabled} onClick={() => add(item.id)}>
        <span className="slip-q">Q{item.eventIndex + 1}</span>
        <span>{others.find(other => other.id === item.id)?.question}</span>
        <span className="slip-side"><span className="slip-points">{signedPoints(item.difference)}</span><span className="slip-add-word">Add</span></span>
      </button>)}
      {noLinks && <p className="slip-note">No questions in this pool are priced together yet. Any question below can be added.</p>}
      {!noLinks && links !== null && remaining.length > 0 && <button type="button" className="slip-toggle" aria-expanded={listOpen} onClick={() => setListOpen(open => !open)}>
        {listOpen ? 'Hide the full list' : `All ${remaining.length} questions in this pool`}</button>}
      {(listOpen || noLinks) && remaining.length > 0 && <>
        <ChoiceList label="Add a question" value={null} searchable options={pickable.map(item => ({ value: item.id, text: item.question,
          label: <><span className="slip-q">Q{item.eventIndex + 1}</span>{' '}{item.question}</>,
          meta: strength(item.eventIndex) != null ? signedPoints(strength(item.eventIndex)!) : undefined }))} onChange={add} className="combo-add" disabled={disabled}/>
        {addable && pickable.length < remaining.length && <p className="slip-caption">Questions the pool cannot price with these answers are not listed.</p>}
      </>}
    </div>;

  return <div className="combination-slip" ref={root}>
    <h3>Your answers</h3>
    <ol className="slip-legs" aria-label="Answers in this prediction">
      {legs.map((leg, index) => <Fragment key={leg.id}>
        {index > 0 && <li className="slip-join" aria-hidden="true"><span>{ruleWord(rule)}</span></li>}
        <li className="slip-leg" data-event={leg.eventIndex}>
          <span className="slip-q">Q{leg.eventIndex + 1}</span>
          <div className="slip-body">
            <p className="slip-question">{leg.question}</p>
            {leg.slot === 0 && <span className="slip-this">This market</span>}
            <div className="slip-answer-row">
              {leg.slot === 0
                ? <SegmentedControl label="Your answer" hideLabel value={side} options={yesNo} onChange={onSide} disabled={disabled} block/>
                : <SegmentedControl label={`Answer for Q${leg.eventIndex + 1}`} hideLabel value={leg.answer} options={yesNo} disabled={disabled} block
                  onChange={answer => onChange(leg.slot === 1 ? { ...value, extra1Side: answer } : { ...value, extra2Side: answer })}/>}
              {leg.slot !== 0 && <button type="button" className="slip-remove" aria-label={`Remove Q${leg.eventIndex + 1}`} disabled={disabled}
                onClick={() => remove(leg.slot as 1 | 2, leg.eventIndex)}><X size={15} aria-hidden="true"/></button>}
            </div>
          </div>
        </li>
      </Fragment>)}
    </ol>
    {mode === 'sell' ? <details className="slip-sell-find" open={findOpen || undefined}><summary>Find another combination</summary>{addArea}</details> : addArea}
    {count >= 2 && <div className="slip-rule">
      <SegmentedControl label="Pays when" value={rule} options={RULE_OPTIONS} onChange={onRule} disabled={disabled} block/>
      <p className="slip-sentence">{payoutSentence(rule, sortedLegs)}</p>
      <OutcomeMap legs={legs.map(leg => ({ eventIndex: leg.eventIndex, side: leg.answer }))} rule={rule} cells={claim?.cells ?? null}/>
      {claim ? <dl className="leaders slip-pool">
        <div><dt>Pool chance this pays</dt><dd>{pct(claim.chance)}</dd></div>
        <div><dt>If the questions were unrelated</dt><dd>{pct(claim.independent)}</dd></div>
        <div><dt>Priced together</dt><dd>{signedPoints(claim.difference)}</dd></div>
      </dl> : whatIfError ? <p className="slip-status" role="status">{whatIfError}</p>
        : <p className="slip-status" role="status">{whatIfLoading || !whatIf ? 'Reading the pool...' : ''}</p>}
      {whatIf && <p className="slip-caption">Pool estimates at block {whatIf.blockNumber}. Your cost below includes price impact and commission.</p>}
    </div>}
    <p className="sr-only" role="status" aria-live="polite">{announce}</p>
  </div>;
}
