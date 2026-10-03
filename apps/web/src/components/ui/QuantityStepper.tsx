import { Minus, Plus } from 'lucide-react';
import { useId } from 'react';

// Direct entry stays authoritative; the buttons only step whole shares within the market limit.
export default function QuantityStepper({ label, value, onChange, max, disabled = false, describedBy }: {
  label: string; value: string; onChange(value: string): void; max?: number | null; disabled?: boolean; describedBy?: string;
}) {
  const id = useId();
  const current = /^\d+(\.\d+)?$/.test(value) ? Number(value) : 0;
  const step = (delta: number) => {
    const next = Math.max(1, Math.floor(current) + delta);
    onChange(String(max ? Math.min(max, next) : next));
  };
  return (
    <div className="field quantity-field">
      <label htmlFor={id}>{label}</label>
      <div className="quantity-stepper">
        <button type="button" className="btn btn-secondary btn-icon" aria-label="Fewer shares" disabled={disabled || current <= 1} onClick={() => step(-1)}><Minus aria-hidden="true" strokeWidth={1.75} /></button>
        <input id={id} value={value} inputMode="decimal" disabled={disabled} aria-describedby={describedBy} onChange={(event) => onChange(event.target.value)} />
        <button type="button" className="btn btn-secondary btn-icon" aria-label="More shares" disabled={disabled || (max != null && current >= max)} onClick={() => step(1)}><Plus aria-hidden="true" strokeWidth={1.75} /></button>
      </div>
    </div>
  );
}
