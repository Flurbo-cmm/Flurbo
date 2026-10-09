import { useId, useState, type ReactNode } from 'react';

export type Choice<T extends string> = { value: T; label: ReactNode; text?: string; meta?: ReactNode; disabled?: boolean };

// A radio group drawn as rows, used wherever a dropdown would otherwise hide the options. Searchable past eight rows.
export default function ChoiceList<T extends string>({ label, hideLabel = false, value, options, onChange, disabled = false, searchable, className = '' }: {
  label: string; hideLabel?: boolean; value: T | null; options: Choice<T>[]; onChange(value: T): void; disabled?: boolean; searchable?: boolean; className?: string;
}) {
  const name = useId();
  const [query, setQuery] = useState('');
  const search = searchable ?? options.length > 8;
  const needle = query.trim().toLowerCase();
  const shown = needle ? options.filter((option) => (option.text ?? String(option.label)).toLowerCase().includes(needle)) : options;
  return (
    <fieldset className={`choice-list ${className}`.trim()} disabled={disabled}>
      <legend className={hideLabel ? 'sr-only' : undefined}>{label}</legend>
      {search && <input className="choice-search" type="search" aria-label={`Search ${label.toLowerCase()}`} placeholder="Filter…" value={query} onChange={(event) => setQuery(event.target.value)} />}
      <div className="choice-rows">
        {shown.map((option) => (
          <label key={option.value} className="choice-row">
            <input type="radio" name={name} value={option.value} checked={value === option.value} disabled={option.disabled}
              onChange={() => onChange(option.value)} />
            <span className="choice-mark" aria-hidden="true" />
            <span>{option.label}</span>
            {option.meta != null && <span className="choice-meta">{option.meta}</span>}
          </label>
        ))}
        {!shown.length && <p className="choice-empty">No match. Clear the filter to see every option.</p>}
      </div>
    </fieldset>
  );
}
