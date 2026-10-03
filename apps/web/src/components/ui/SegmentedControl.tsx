import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

export type SegmentOption<T extends string> = { value: T; label: ReactNode; disabled?: boolean };

// Radio-group semantics for two to five choices: one tab stop, arrow keys move the selection.
export default function SegmentedControl<T extends string>({ label, hideLabel = false, value, options, onChange, disabled = false, block = false, className = '' }: {
  label: string; hideLabel?: boolean; value: T; options: SegmentOption<T>[]; onChange(value: T): void; disabled?: boolean; block?: boolean; className?: string;
}) {
  const id = useId();
  const group = useRef<HTMLDivElement>(null);
  const enabled = options.filter((option) => !option.disabled);
  function onKey(event: KeyboardEvent<HTMLButtonElement>) {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    const edge = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : null;
    if (!step && edge === null) return;
    event.preventDefault();
    const index = enabled.findIndex((option) => option.value === value);
    const next = enabled[edge ?? (index + step + enabled.length) % enabled.length];
    if (!next) return;
    onChange(next.value);
    requestAnimationFrame(() => group.current?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(next.value)}"]`)?.focus());
  }
  return (
    <div className={`segmented-field ${className}`.trim()}>
      <span id={id} className={hideLabel ? 'sr-only' : 'segmented-label'}>{label}</span>
      <div ref={group} role="radiogroup" aria-labelledby={id} aria-disabled={disabled || undefined} className={`segmented${block ? ' segmented-block' : ''}`}>
        {options.map((option) => {
          const checked = option.value === value;
          return <button key={option.value} type="button" role="radio" data-value={option.value} aria-checked={checked}
            tabIndex={checked ? 0 : -1} disabled={disabled || option.disabled}
            onClick={() => { if (!checked) onChange(option.value); }} onKeyDown={onKey}>{option.label}</button>;
        })}
      </div>
    </div>
  );
}
