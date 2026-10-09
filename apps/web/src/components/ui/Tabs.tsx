import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { m } from 'framer-motion';

export type TabItem<T extends string> = { id: T; label: ReactNode; count?: number; panel: ReactNode };
const SLIDE = { type: 'spring', stiffness: 560, damping: 42, mass: 0.6 } as const;

// ARIA tabs with a roving tab stop. Every panel stays mounted (hidden when inactive) so a panel never loses its state.
export default function Tabs<T extends string>({ label, tabs, value, onChange, className = '' }: {
  label: string; tabs: TabItem<T>[]; value: T; onChange(value: T): void; className?: string;
}) {
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  function onKey(event: KeyboardEvent<HTMLButtonElement>) {
    const index = tabs.findIndex((tab) => tab.id === value);
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault();
    onChange(tabs[next].id);
    requestAnimationFrame(() => list.current?.querySelector<HTMLButtonElement>(`#${CSS.escape(`${id}-tab-${tabs[next].id}`)}`)?.focus());
  }
  return (
    <div className={`tab-set ${className}`.trim()}>
      <div ref={list} className="tabs" role="tablist" aria-label={label}>
        {tabs.map((tab) => {
          const selected = tab.id === value;
          return <button key={tab.id} id={`${id}-tab-${tab.id}`} type="button" role="tab" aria-selected={selected} aria-controls={`${id}-panel-${tab.id}`}
            tabIndex={selected ? 0 : -1} onClick={() => onChange(tab.id)} onKeyDown={onKey}>
            {selected && <m.span className="tab-ink" layoutId={`tab-${id}`} transition={SLIDE} aria-hidden="true" />}
            <span className="tab-label">{tab.label}</span>
            {tab.count != null && <span className="tab-count">{tab.count}</span>}
          </button>;
        })}
      </div>
      {tabs.map((tab) => (
        <div key={tab.id} id={`${id}-panel-${tab.id}`} role="tabpanel" aria-labelledby={`${id}-tab-${tab.id}`} hidden={tab.id !== value} className="tab-panel">
          {tab.panel}
        </div>
      ))}
    </div>
  );
}
