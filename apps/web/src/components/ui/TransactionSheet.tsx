import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { m } from 'framer-motion';
import { X } from 'lucide-react';
import { canDismiss, type SheetPhase } from '../../sheet-state';

export type { SheetPhase };
const ENTER = { duration: 0.2, ease: [0.22, 1, 0.36, 1] } as const;

// Every wallet confirmation opens here. It renders inside the flow that owns it (never portalled). A modal sheet is
// lifted into the top layer by the native dialog; a docked sheet stays in the ticket for flows whose review prepares
// itself as the member edits, so the page stays usable. The flow keeps all of its state; the sheet only shows it.
export default function TransactionSheet({ phase, title, network = 'Monad testnet', hash = null, mode = 'modal', onDismiss, onMinimize, dismissLabel = 'Close', steps, alert, children, actions }: {
  phase: SheetPhase; title: string; network?: 'Monad testnet' | 'Sepolia'; hash?: string | null; mode?: 'modal' | 'docked';
  onDismiss?: () => void; onMinimize?: () => void; dismissLabel?: string; steps?: { label: string; current: boolean }[]; alert?: ReactNode; children: ReactNode; actions?: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [minimized, setMinimized] = useState(false);
  const modal = mode === 'modal';
  const minimizable = modal && phase === 'pending' && !!hash;
  const dismissible = canDismiss(phase, !!hash) && (minimizable || !!onDismiss);
  const open = phase !== 'closed' && !minimized;
  const wasOpen = useRef(false);
  useEffect(() => { if (phase !== 'pending') setMinimized(false); }, [phase]);
  useLayoutEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) {
      if (modal) { node.showModal(); heading.current?.focus({ preventScroll: true }); }
      else node.show();
    }
    if (!open && node.open) node.close();
    // A docked sheet that just appeared below the fold is brought into view once, without moving focus.
    if (open && !modal && !wasOpen.current) requestAnimationFrame(() => {
      const box = node.getBoundingClientRect();
      if (box.top > window.innerHeight - 160 || box.bottom < 0) node.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    });
    wasOpen.current = open;
  }, [open, modal]);
  useEffect(() => () => { if (dialog.current?.open) dialog.current.close(); }, []);
  const dismiss = () => {
    if (!dismissible) return;
    if (minimizable) { setMinimized(true); onMinimize?.(); }
    else onDismiss?.();
  };
  return (
    <dialog ref={dialog} className={`sheet${modal ? '' : ' sheet-docked'}`} aria-label={title} data-phase={phase}
      onCancel={(event) => { event.preventDefault(); dismiss(); }}
      onKeyDown={(event) => { if (!modal && event.key === 'Escape') { event.stopPropagation(); dismiss(); } }}
      onClick={(event) => { if (modal && event.target === event.currentTarget) dismiss(); }}>
      {open && <>
        <div className="sheet-top">
          <span className="sheet-grabber" aria-hidden="true" />
          <div className="sheet-head">
            <h3 ref={heading} tabIndex={-1}>{title}</h3>
            <span className="tag tag-net">{network}</span>
            {dismissible ? <button type="button" className="sheet-close" aria-label={minimizable ? 'Hide and keep tracking' : dismissLabel} onClick={dismiss}><X aria-hidden="true" strokeWidth={1.75} /></button> : <span aria-hidden="true" />}
          </div>
        </div>
        <m.div className="sheet-body" initial={modal ? { opacity: 0, y: 8 } : false} animate={{ opacity: 1, y: 0 }} transition={ENTER}>
          {steps && steps.length > 1 && <ol className="sheet-steps" aria-label="Steps">{steps.map((step) => <li key={step.label} aria-current={step.current ? 'step' : undefined}><i aria-hidden="true" />{step.label}</li>)}</ol>}
          {alert}
          {children}
        </m.div>
        {actions && <div className="sheet-actions">{actions}</div>}
      </>}
    </dialog>
  );
}
