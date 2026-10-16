import { X } from 'lucide-react';
import SegmentedControl from '../ui/SegmentedControl';
import ChoiceList from '../ui/ChoiceList';
import { availableToAdd, chosenChips, type ComboState } from '../../combo-picker-model';

export type { ComboState };

// Up to two more questions from the same pool, each with its own answer. Chosen questions are chips with their answer;
// the rest sit in one searchable list, so the ticket stays short however many questions the pool has.
export default function ComboPicker({ others, value, onChange, disabled = false, legend = 'Combine with another question' }: {
  others: { id: string; question: string }[]; value: ComboState; onChange(next: ComboState): void; disabled?: boolean; legend?: string;
}) {
  const { extra1, extra2, extra2Side } = value;
  const chips = chosenChips(others, value);
  const remaining = availableToAdd(others, value);
  const add = (id: string) => { if (!extra1) onChange({ ...value, extra1: id, extra1Side: 'yes' }); else if (!extra2) onChange({ ...value, extra2: id, extra2Side: 'yes' }); };
  const remove = (slot: 1 | 2) => onChange(slot === 1
    ? { ...value, extra1: extra2, extra1Side: extra2 ? extra2Side : 'yes', extra2: '', extra2Side: 'yes' }
    : { ...value, extra2: '', extra2Side: 'yes' });
  const answer = (slot: 1 | 2, side: 'yes' | 'no') => onChange(slot === 1 ? { ...value, extra1Side: side } : { ...value, extra2Side: side });
  return (
    <fieldset className="combo-picker" disabled={disabled}>
      <legend>{legend}</legend>
      <p className="field-help">Every selected answer counts toward one combined position. Up to three questions from this pool.</p>
      {chips.length > 0 && <ul aria-label="Questions in this combination">
        {chips.map(chip => <li key={chip.id} className="combo-row is-chosen">
          <span className="combo-chip"><span>{chip.question}</span>
            <button type="button" className="combo-remove" aria-label={`Remove ${chip.question}`} onClick={() => remove(chip.slot as 1 | 2)}><X size={14} aria-hidden="true"/></button></span>
          <SegmentedControl label={`Answer for ${chip.question}`} hideLabel value={chip.side}
            options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} onChange={side => answer(chip.slot as 1 | 2, side)} className="combo-answer" />
        </li>)}
      </ul>}
      {remaining.length > 0
        ? <ChoiceList label="Add a question" value={null} searchable options={remaining.map(item => ({ value: item.id, label: item.question, text: item.question }))} onChange={add} className="combo-add"/>
        : chips.length > 0 && <p className="field-help">Three questions is the most one prediction can combine. Remove one to add another.</p>}
    </fieldset>
  );
}
