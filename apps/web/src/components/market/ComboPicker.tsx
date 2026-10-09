import SegmentedControl from '../ui/SegmentedControl';

export type ComboState = { extra1: string; extra2: string; extra1Side: 'yes' | 'no'; extra2Side: 'yes' | 'no' };

// Up to two more questions from the same pool, each with its own answer. Rows instead of dropdowns; a third extra
// question stays disabled until one is removed.
export default function ComboPicker({ others, value, onChange, disabled = false, legend = 'Combine with another question' }: {
  others: { id: string; question: string }[]; value: ComboState; onChange(next: ComboState): void; disabled?: boolean; legend?: string;
}) {
  const { extra1, extra2, extra1Side, extra2Side } = value;
  const toggle = (id: string) => {
    if (id === extra1) onChange({ ...value, extra1: extra2, extra1Side: extra2 ? extra2Side : 'yes', extra2: '', extra2Side: 'yes' });
    else if (id === extra2) onChange({ ...value, extra2: '', extra2Side: 'yes' });
    else if (!extra1) onChange({ ...value, extra1: id, extra1Side: 'yes' });
    else if (!extra2) onChange({ ...value, extra2: id, extra2Side: 'yes' });
  };
  const side = (id: string, answer: 'yes' | 'no') => onChange(id === extra1 ? { ...value, extra1Side: answer } : { ...value, extra2Side: answer });
  return (
    <fieldset className="combo-picker" disabled={disabled}>
      <legend>{legend}</legend>
      <p className="field-help">Every selected answer counts toward one combined position. Up to three questions from this pool.</p>
      <ul>
        {others.map((item) => {
          const chosen = item.id === extra1 || item.id === extra2, full = !!extra1 && !!extra2 && !chosen;
          return <li key={item.id} className={`combo-row${chosen ? ' is-chosen' : ''}`}>
            <label className="check-row"><input type="checkbox" checked={chosen} disabled={full} onChange={() => toggle(item.id)} /><span>{item.question}</span></label>
            {chosen && <SegmentedControl label={`Answer for ${item.question}`} hideLabel value={item.id === extra1 ? extra1Side : extra2Side}
              options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} onChange={(answer) => side(item.id, answer)} className="combo-answer" />}
          </li>;
        })}
      </ul>
    </fieldset>
  );
}
