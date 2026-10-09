import { ChevronLeft, ChevronRight } from 'lucide-react';

// Page buttons for up to seven pages; past that, previous and next with the page count.
export default function Pager({ page, pageCount, onPage, label = 'Pages', className = '' }: {
  page: number; pageCount: number; onPage(page: number): void; label?: string; className?: string;
}) {
  if (pageCount <= 1) return null;
  const numbered = pageCount <= 7;
  return (
    <nav className={`pager ${className}`.trim()} aria-label={label}>
      <button type="button" aria-label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)}><ChevronLeft aria-hidden="true" strokeWidth={1.75} /></button>
      {numbered ? Array.from({ length: pageCount }, (_, i) => i + 1).map((n) => (
        <button key={n} type="button" className="pager-number" aria-label={`Page ${n}`} aria-current={n === page ? 'page' : undefined} onClick={() => onPage(n)}>{n}</button>
      )) : null}
      <span className={`pager-status${numbered ? ' sr-only' : ''}`}>Page {page} of {pageCount}</span>
      <button type="button" aria-label="Next page" disabled={page >= pageCount} onClick={() => onPage(page + 1)}><ChevronRight aria-hidden="true" strokeWidth={1.75} /></button>
    </nav>
  );
}
