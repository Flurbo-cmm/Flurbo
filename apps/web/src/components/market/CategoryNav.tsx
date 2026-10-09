import { m } from 'framer-motion';
import type { CategorySlug } from '../../market-categories';

const SLIDE = { type: 'spring', stiffness: 560, damping: 42, mass: 0.6 } as const;

// Real links, one per category that has markets, with the count. Wraps to a second line; never scrolls sideways.
export default function CategoryNav({ categories, active, hrefFor, onSelect }: {
  categories: { slug: CategorySlug; label: string; count: number }[]; active: CategorySlug; hrefFor(slug: CategorySlug): string; onSelect(slug: CategorySlug): void;
}) {
  return (
    <nav className="category-nav" aria-label="Market categories">
      {categories.map((c) => {
        const current = c.slug === active;
        return <a key={c.slug} href={hrefFor(c.slug)} aria-current={current ? 'page' : undefined}
          onClick={(event) => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return; event.preventDefault(); onSelect(c.slug); }}>
          {current && <m.span className="category-ink" layoutId="category-ink" transition={SLIDE} aria-hidden="true" />}
          <span className="category-label">{c.label}</span>
          <span className="num category-count">{c.count}</span>
        </a>;
      })}
    </nav>
  );
}
