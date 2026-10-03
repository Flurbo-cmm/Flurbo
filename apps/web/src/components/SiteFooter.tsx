import { Link } from 'wouter';
import BrandLogo from './BrandLogo';

export const LITEPAPER = { href: '/technical_litepaper.pdf', label: 'Technical litepaper', detail: 'PDF, 99 KB' } as const;

export default function SiteFooter({ compact = false }: { compact?: boolean }) {
  return (
    <footer className={`site-footer${compact ? ' compact' : ''}`}>
      <div className="site-footer-inner">
        <div className="footer-brand">
          <Link href="/" aria-label="Flurbo home" className="brand-link"><BrandLogo title="Flurbo" /></Link>
          {!compact && <p>One pool. More possibilities.</p>}
        </div>
        <nav className="footer-links" aria-label="Footer">
          <Link href="/docs">Docs</Link>
          <a href={LITEPAPER.href} type="application/pdf">{LITEPAPER.label} <span className="muted">({LITEPAPER.detail})</span></a>
          <a href="/#how-it-works">How it works</a>
        </nav>
        <p className="footer-note">Monad testnet. Test assets only.</p>
      </div>
    </footer>
  );
}
