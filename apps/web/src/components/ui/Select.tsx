import { ChevronDown, Check } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export type SelectOption<T extends string> = { value: T; label: ReactNode; text: string; disabled?: boolean };

const coarse = () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;

// Select-only combobox (WAI-ARIA APG): focus stays on the button, arrows move the active
// option, Enter or Space chooses, Escape closes. Long labels wrap instead of clipping.
// Touch devices get the native control, which is more reliable there.
export default function Select<T extends string>({ label, value, options, onChange, disabled = false, hideLabel = false, className = '' }: {
  label: string; value: T; options: SelectOption<T>[]; onChange(value: T): void; disabled?: boolean; hideLabel?: boolean; className?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(() => Math.max(0, options.findIndex((o) => o.value === value)));
  const [native] = useState(coarse);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const typed = useRef({ text: '', at: 0 });
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  useEffect(() => { if (open) document.getElementById(`${id}-opt-${active}`)?.scrollIntoView({ block: 'nearest' }); }, [open, active, id]);

  if (native) return (
    <div className={`field select-field ${className}`.trim()}>
      <label htmlFor={`${id}-native`} className={hideLabel ? 'sr-only' : undefined}>{label}</label>
      <select id={`${id}-native`} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as T)}>
        {options.map((o) => <option key={o.value} value={o.value} disabled={o.disabled}>{o.text}</option>)}
      </select>
    </div>
  );

  const move = (from: number, step: number) => {
    for (let i = 1; i <= options.length; i += 1) {
      const next = (from + step * i + options.length) % options.length;
      if (!options[next].disabled) return next;
    }
    return from;
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    setOpen(false);
    if (option.value !== value) onChange(option.value);
    button.current?.focus();
  };
  function onKey(event: KeyboardEvent<HTMLButtonElement>) {
    const key = event.key;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(key)) { event.preventDefault(); setActive(Math.max(0, options.findIndex((o) => o.value === value))); setOpen(true); }
      return;
    }
    if (key === 'Escape') { event.preventDefault(); setOpen(false); return; }
    if (key === 'Tab') { setOpen(false); return; }
    if (key === 'ArrowDown' || key === 'ArrowUp') { event.preventDefault(); setActive((i) => move(i, key === 'ArrowDown' ? 1 : -1)); return; }
    if (key === 'Home' || key === 'End') { event.preventDefault(); setActive(move(key === 'Home' ? -1 : 0, key === 'Home' ? 1 : -1)); return; }
    if (key === 'Enter' || key === ' ') { event.preventDefault(); choose(active); return; }
    if (key.length === 1) {
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : '') + key.toLowerCase(), at: now };
      const match = options.findIndex((o) => !o.disabled && o.text.toLowerCase().startsWith(typed.current.text));
      if (match >= 0) setActive(match);
    }
  }
  return (
    <div ref={root} className={`field select-field ${className}`.trim()}>
      <span id={`${id}-label`} className={hideLabel ? 'sr-only' : 'field-label'}>{label}</span>
      <div className="select">
        <button ref={button} type="button" role="combobox" className="select-button" aria-labelledby={`${id}-label`}
          aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-list`} disabled={disabled}
          aria-activedescendant={open ? `${id}-opt-${active}` : undefined}
          onClick={() => { setActive(Math.max(0, options.findIndex((o) => o.value === value))); setOpen((o) => !o); }} onKeyDown={onKey}>
          <span className="select-value">{selected?.label ?? 'Choose'}</span>
          <ChevronDown aria-hidden="true" strokeWidth={1.75} />
        </button>
        {open && <ul id={`${id}-list`} role="listbox" aria-labelledby={`${id}-label`} className="select-list">
          {options.map((o, i) => <li key={o.value} id={`${id}-opt-${i}`} role="option" aria-selected={o.value === value} aria-disabled={o.disabled || undefined}
            className={`${i === active ? 'active' : ''}`} onPointerDown={(event) => event.preventDefault()} onClick={() => choose(i)} onMouseEnter={() => !o.disabled && setActive(i)}>
            <span>{o.label}</span>{o.value === value && <Check aria-hidden="true" strokeWidth={2} />}
          </li>)}
        </ul>}
      </div>
    </div>
  );
}
