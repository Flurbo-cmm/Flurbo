import { Ban, CircleCheck, CircleDot, CircleSlash2, Clock, Hourglass, Lock, Scale, Flag, type LucideIcon } from 'lucide-react';

export type StatusKind = 'open' | 'closing' | 'closed' | 'settled' | 'unavailable' | 'waiting' | 'challenge' | 'disputed' | 'void' | 'collect' | 'nopayout';
const ICONS: Partial<Record<StatusKind, LucideIcon>> = { open: CircleDot, closing: Clock, closed: Lock, settled: CircleCheck, unavailable: Ban, waiting: Hourglass, challenge: Flag, disputed: Scale, void: Ban, nopayout: CircleSlash2 };
const ATTENTION = new Set<StatusKind>(['closing', 'challenge', 'collect']);

// Status always pairs a shape with a word, so it never relies on color alone.
export default function StatusBadge({ kind, children, className = '' }: { kind: StatusKind; children: React.ReactNode; className?: string }) {
  const Icon = ICONS[kind];
  return <span className={`status status-${kind}${ATTENTION.has(kind) ? ' status-attention' : ''}${kind === 'unavailable' || kind === 'void' || kind === 'nopayout' ? ' status-muted' : ''} ${className}`.trim()}>
    {Icon && <Icon aria-hidden="true" strokeWidth={1.75} />}{children}
  </span>;
}
