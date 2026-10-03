import { Check } from 'lucide-react';
import type { ReactNode } from 'react';

export type Step = { key: string; title: ReactNode; meta?: ReactNode; state: 'done' | 'current' | 'upcoming'; children?: ReactNode };

// A vertical sequence where order is real information: access, settlement, agent setup.
export default function Stepper({ steps, label, className = '' }: { steps: Step[]; label: string; className?: string }) {
  return (
    <ol className={`stepper ${className}`.trim()} aria-label={label}>
      {steps.map((step) => (
        <li key={step.key} className={step.state} aria-current={step.state === 'current' ? 'step' : undefined}>
          <span className="step-marker" aria-hidden="true">{step.state === 'done' && <Check strokeWidth={2.5} />}</span>
          <div className="step-body">
            <span className="step-title">{step.title}{step.state === 'current' && <span className="step-now">Now</span>}{step.state === 'done' && <span className="sr-only"> (done)</span>}</span>
            {step.meta && <span className="step-meta">{step.meta}</span>}
            {step.children}
          </div>
        </li>
      ))}
    </ol>
  );
}
