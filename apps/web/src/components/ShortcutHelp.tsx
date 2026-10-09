import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { SHORTCUT_HELP, shortcutFor } from '../shortcuts';

// Press ? anywhere outside a text field to list the keyboard shortcuts.
export default function ShortcutHelp() {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const busy = !!document.querySelector('dialog[open]');
      if (shortcutFor(event, event.target as HTMLElement | null, 'board', busy) === 'help') { event.preventDefault(); setOpen(true); }
    };
    const onOpen = () => setOpen(true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('flurbo:shortcuts', onOpen);
    return () => { document.removeEventListener('keydown', onKey); window.removeEventListener('flurbo:shortcuts', onOpen); };
  }, []);
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);
  return (
    <dialog ref={dialog} className="sheet shortcut-sheet" aria-label="Keyboard shortcuts" onClose={() => setOpen(false)}
      onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      {open && <>
        <div className="sheet-head"><h3>Keyboard shortcuts</h3><span /><button type="button" className="sheet-close" aria-label="Close shortcuts" onClick={() => setOpen(false)}><X aria-hidden="true" strokeWidth={1.75} /></button></div>
        <div className="sheet-body">
          {(['board', 'market'] as const).map((scope) => <section key={scope}>
            <h4 className="shortcut-scope">{scope === 'board' ? 'Market board' : 'Market page'}</h4>
            <dl className="shortcut-list">{SHORTCUT_HELP.filter((item) => item.scope === scope).map((item) => <div key={item.label}><dt>{item.keys.map((k) => <kbd key={k}>{k}</kbd>)}</dt><dd>{item.label}</dd></div>)}</dl>
          </section>)}
          <p className="small muted">Shortcuts choose and move. Every transaction still needs your confirmation in the sheet and in your wallet.</p>
        </div>
        <div className="sheet-actions" />
      </>}
    </dialog>
  );
}
