import { ArrowUpRight, Menu, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, Redirect, Route, Switch, useLocation } from "wouter";
import Home from "./pages/Home";
import Docs from './pages/Docs';
import AuthPage from "./pages/AuthPage";
import NotFound from "./pages/NotFound";
import { useAuth } from "./auth/context";
import {usePreviewAccess} from './auth/preview-access';
import BrandLogo from './components/BrandLogo';
import SiteFooter from './components/SiteFooter';
import { useLoadGate } from './loading/gates';
import { rememberReturnPath } from './return-path';
import { preloadRoutes, useRoutePage, type RouteKey } from './routes';

export const brand = "flurbo";

const APP_LINKS = [
  { href: '/markets', label: 'Markets', match: (path: string) => path === '/markets' || path.startsWith('/markets/') },
  { href: '/oracle', label: 'Oracle', match: (path: string) => path === '/oracle' || path.startsWith('/oracle/') },
  { href: '/agents', label: 'Agents', match: (path: string) => path === '/agents' || path.startsWith('/agents/') },
  { href: '/portfolio', label: 'Portfolio', match: (path: string) => path === '/portfolio' },
  { href: '/access', label: 'Your account', match: (path: string) => path === '/access' },
];

function Header() {
  const { state } = useAuth();
  const [location] = useLocation();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const header = useRef<HTMLElement>(null);
  const sentinel = useRef<HTMLSpanElement>(null);
  const isHome = location === "/";
  const signedIn = !!state.address;

  useEffect(() => setOpen(false), [location]);
  useEffect(() => {
    const node = sentinel.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => setScrolled(!entry.isIntersecting));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        menuButton.current?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (!header.current?.contains(event.target as Node)) setOpen(false);
    };
    // This is a non-modal disclosure; normal tab order stays available.
    header.current?.querySelector<HTMLAnchorElement>("nav a")?.focus();
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  const current = (match: boolean) => (match ? 'page' as const : undefined);
  return (
    <>
      <span ref={sentinel} className="header-sentinel" aria-hidden="true" />
      <header ref={header} className={`site-header ${isHome ? "site-header-home" : "site-header-subpage"}`} data-scrolled={scrolled}>
        <div className="header-inner">
          <Link href="/" className="brand-link" aria-label="Flurbo home">
            <BrandLogo title="Flurbo" />
          </Link>
          <nav id="main-nav" className={`main-nav ${open ? "main-nav-open" : ""}`} aria-label="Main navigation"
            onClick={(event) => {
              if ((event.target as HTMLElement).closest("a")) setOpen(false);
            }}>
            <div className="nav-links">
              {state.restoring ? <span role="status" className="nav-loading">Loading your account...</span>
                : signedIn ? APP_LINKS.map((link) => <Link key={link.href} href={link.href} aria-current={current(link.match(location))}>{link.label}</Link>)
                : <><a href="/#how-it-works">How it works</a><a href="/#the-idea">The idea</a></>}
              <Link href="/docs" aria-current={current(location === '/docs')}>Docs</Link>
            </div>
            <span className="nav-rule" aria-hidden="true" />
            <div className="nav-actions">
              {state.restoring ? null : signedIn ? <>
                <span className="network-indicator"><i aria-hidden="true" /><span>Monad testnet<span className="network-detail">, test assets only</span></span></span>
                {isHome ? <Link href="/markets" className="btn btn-primary btn-sm nav-cta">Explore markets <ArrowUpRight size={15} strokeWidth={1.75} /></Link>
                  : <Link href="/" className="nav-login">About Flurbo</Link>}
              </> : <>
                {location !== '/login' && <Link href="/login" className="nav-login">Sign in</Link>}
                {location !== '/signup' && <Link href="/signup" className="btn btn-primary btn-sm nav-cta">Get early access <ArrowUpRight size={15} strokeWidth={1.75} /></Link>}
              </>}
            </div>
          </nav>
          <button ref={menuButton} className="mobile-menu" type="button" aria-label={open ? "Close navigation" : "Open navigation"} aria-controls="main-nav" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            {open ? <X size={22} strokeWidth={1.75} /> : <Menu size={22} strokeWidth={1.75} />}
          </button>
        </div>
      </header>
    </>
  );
}

function AppShell({ children, compactFooter = false }: { children: React.ReactNode; compactFooter?: boolean }) {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">Skip to content</a>
      <Header />
      {children}
      <SiteFooter compact={compactFooter} />
    </div>
  );
}

function AuthShell({ mode }: { mode: "login" | "signup" | "account" }) {
  return (
    <AppShell compactFooter>
      <AuthPage mode={mode} />
    </AppShell>
  );
}

function AccountRoute() {
  const preview = usePreviewAccess();
  const testingAccess = preview.access?.testingTools===true;
  const [location] = useLocation();
  const { controller, state } = useAuth();
  const [, navigate] = useLocation();
  const authenticated = !!state.address && state.expiresAt !== null && state.expiresAt > Date.now();
  const checkingAccess = authenticated && !preview.access && !preview.error;
  const checking = state.restoring || checkingAccess;
  const operatorPath = ['/account','/events','/evidence','/metrics'].includes(location);
  // Same page choice as before; the page for this address starts loading during the checks.
  const locationKey: RouteKey | null = location==='/access' ? 'access' : location==='/fund' ? 'fund'
    : operatorPath ? (checking || !testingAccess ? null : location==='/evidence' ? 'evidence' : location==='/metrics' ? 'metrics' : 'workspace')
    : location==='/oracle'||location.startsWith('/oracle/') ? 'oracle'
    : location==='/agents'||location.startsWith('/agents/') ? 'agents'
    : location.startsWith('/markets/')||['/markets','/portfolio'].includes(location) ? 'markets' : 'workspace';
  const approved = !!preview.access?.approved;
  const key: RouteKey | null = !authenticated ? null : checking ? locationKey : !approved ? 'access' : locationKey;
  const route = useRoutePage(key);
  const loadingPage = authenticated && !checking && key !== null && !route.Page && !route.error;
  const gate = useLoadGate('app', {
    pending: checking || loadingPage,
    error: authenticated && !preview.access && preview.error ? preview.error : route.error,
    label: state.restoring ? 'Checking your session' : checkingAccess ? 'Checking your access' : 'Loading the page',
    // A stalled page download is retried by reloading; a stalled check by checking again.
    retry: route.error ? route.retry : checking ? preview.refresh : undefined,
  });

  useEffect(() => { if (approved) preloadRoutes(['markets', 'agents', 'access', 'fund']); }, [approved]);

  useEffect(() => {
    if (!state.restoring && !authenticated) {
      rememberReturnPath(window.location.pathname + window.location.search);
      navigate('/login', { replace: true });
    }
  }, [state.restoring, authenticated, navigate]);

  useEffect(() => {
    if (!authenticated || state.expiresAt === null) return;
    const timer = setTimeout(controller.checkExpiry, Math.max(0, state.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [controller, authenticated, state.expiresAt]);

  // Do not mount the market, its data requests or wallet listeners until the
  // server-backed login and access have been confirmed. Remembered addresses are not login.
  const waiting = checking || loadingPage;
  const Page = route.Page;
  const busyText = state.restoring ? 'Checking your session...' : checkingAccess ? 'Checking your access...' : 'Loading the page...';
  return <AppShell compactFooter>{waiting
    ? <main id="main" tabIndex={-1} className="page route-pending" aria-busy="true">
        {!gate.covered && <><span className="progress-line" aria-hidden="true" /><p role="status" className="busy-text">{busyText}</p></>}
        {gate.covered && <p role="status" className="sr-only">{busyText}</p>}
      </main>
    : !authenticated ? null
    : route.error ? <main id="main" tabIndex={-1} className="page page-task"><div className="state-block"><h1>This page did not load</h1><p role="alert">{route.error}</p><button type="button" className="btn btn-primary" onClick={route.retry}>Try again</button></div></main>
    : approved && location!=='/access' && location!=='/fund' && operatorPath && !testingAccess ? <main id="main" tabIndex={-1} className="page page-task"><div className="state-block"><h1>Operator access only</h1><p>This page is for Flurbo operators.</p><Link href="/markets" className="btn btn-secondary">Back to markets</Link></div></main>
    : Page ? (key === 'access' ? <Page {...preview}/> : <Page/>) : null}</AppShell>;
}

function pageTitle(location: string) {
  return location === "/login" ? "Sign in | flurbo"
    : location === "/signup" ? "Create an account | flurbo"
    : /^\/markets\/[^/]+\/[0-3]\/thesis$/.test(location) ? "Build your thesis | flurbo"
    : location.startsWith("/markets") ? "Markets | flurbo"
    : location.startsWith("/oracle") ? "Reality resolution | flurbo"
    : location === "/access" ? "Your account | flurbo"
    : location === "/fund" ? "Get test funds | flurbo"
    : location === "/docs" ? "Documentation | flurbo"
    : location === "/account" ? "Your account | flurbo"
    : location === "/portfolio" ? "Your portfolio | flurbo"
    : location.startsWith("/agents") ? "Agents | flurbo"
    : location === "/events" ? "Real events | flurbo"
    : location === "/evidence" ? "Evidence review | flurbo"
    : location === "/metrics" ? "Metrics | flurbo"
    : location === "/" ? "flurbo | combine what you know" : "Page not found | flurbo";
}

export default function App() {
  const [location] = useLocation();
  const companySite = window.location.hostname === 'flurbopm.singu.online';
  const previousLocation = useRef(location);
  useEffect(() => {
    document.title = pageTitle(location);
    const changed = previousLocation.current !== location;
    previousLocation.current = location;
    const frame = requestAnimationFrame(() => {
      const anchor = window.location.hash ? document.getElementById(window.location.hash.slice(1)) : null;
      if (anchor) anchor.scrollIntoView();
      else if (changed) window.scrollTo({ top: 0, behavior: "instant" });
      if (changed) document.getElementById("main")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [location]);
  return (
    <Switch>
      <Route path="/" component={() => <AppShell><Home /></AppShell>} />
      <Route path="/docs" component={() => <AppShell><Docs /></AppShell>} />
      <Route path="/login" component={() => <AuthShell mode="login" />} />
      <Route path="/signup" component={() => <AuthShell mode="signup" />} />
      <Route path="/markets" component={AccountRoute} />
      <Route path="/oracle" component={AccountRoute} />
      <Route path="/oracle/:id" component={AccountRoute} />
      <Route path="/markets/:collection/:event" component={AccountRoute} />
      <Route path="/markets/:collection/:event/thesis" component={AccountRoute} />
      <Route path="/fund" component={AccountRoute} />
      <Route path="/access" component={AccountRoute} />
      <Route path="/account">{companySite ? <Redirect to="/markets" replace /> : <AccountRoute />}</Route>
      <Route path="/portfolio" component={AccountRoute} />
      <Route path="/agents" component={AccountRoute} />
      <Route path="/agents/:id" component={AccountRoute} />
      <Route path="/history"><Redirect to="/portfolio" replace /></Route>
      <Route path="/events">{companySite ? <Redirect to="/markets" replace /> : <AccountRoute />}</Route>
      <Route path="/evidence">{companySite ? <Redirect to="/markets" replace /> : <AccountRoute />}</Route>
      <Route path="/metrics" component={AccountRoute} />
      <Route component={() => <AppShell><NotFound /></AppShell>} />
    </Switch>
  );
}
