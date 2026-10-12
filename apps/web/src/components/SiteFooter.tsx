import { Link } from 'wouter';
import BrandLogo from './BrandLogo';

export default function SiteFooter({ compact = false }: { compact?: boolean }) {
  return (
    <footer className={`site-footer${compact ? ' compact' : ''}`}>
      <div className="site-footer-inner">
        <div className="footer-brand">
          <Link href="/" aria-label="Flurbo home" className="brand-link"><BrandLogo title="Flurbo" /></Link>
        </div>
        <nav className="footer-links" aria-label="Footer">
          <Link href="/docs">Docs</Link>
          <a href="/#how-it-works">How it works</a>
        </nav>
        <p className="footer-note">Monad testnet preview. Test assets only.</p>
      </div>
    </footer>
  );
}
