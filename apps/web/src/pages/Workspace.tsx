import {linkTradingWallet} from '../wallet-links';
import AccountPortfolio from './AccountPortfolio';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { ArrowUpRight, ArrowLeft, Layers3, Wallet, Activity, LogOut, Copy, Check } from 'lucide-react';
import { useAuth } from '../auth/context';
import { mountDashboard } from '../../../dashboard/app.mjs';
import dashboardHtml from '../../../dashboard/index.html?raw';
import dashboardCss from '../../../dashboard/styles.css?raw';
import workspaceCss from './workspace-core.css?raw';
import './workspace.css';
import Funding from './Funding';
import LearningComparison from './LearningComparison';
import LearningPool from './LearningPool';
import Pilot from './Pilot';
import { walletKey, tradingWalletKey, rememberedTradingWallet } from '../portfolio';
const publicTestnet = import.meta.env.PROD;

type Panel = 'trade' | 'positions' | 'activity';
type Market = 'original' | 'learning' | 'pilot';
function CoreMarket({ account, panel, market, onBusy }: { account: string | null; panel: Panel; market: 'original' | 'learning'; onBusy(busy: boolean): void }) {
  const { controller, state } = useAuth();
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const shadow = host.current!.shadowRoot || host.current!.attachShadow({ mode: 'open' });
    const source = new DOMParser().parseFromString(dashboardHtml, 'text/html');
    const main = source.querySelector('main')!;
    main.querySelector('.hero')?.remove(); main.querySelector('footer')?.remove();
    main.removeAttribute('id'); main.className = 'mvp-content';
    main.querySelector('#compose-title')!.textContent = 'Build your prediction.';
    main.querySelector('#account-title')!.textContent = 'Your positions.';
    main.querySelector('#trade-title')!.textContent = 'Make it yours.';
    main.querySelector('#quote-button')!.classList.replace('primary', 'secondary');
    main.querySelector('label[for="side"]')!.textContent = 'Buy or sell';
    main.querySelector('label[for="quantity"]')!.textContent = 'Number of shares';
    const tradingBalance = document.createElement('p');
    tradingBalance.id = 'trade-wallet-balance'; tradingBalance.className = 'caption';
    tradingBalance.setAttribute('role', 'status');
    main.querySelector('#signer-status')!.after(tradingBalance);
    (main.querySelector('.book') as HTMLElement).style.display = 'none';
    main.querySelector('.account > .muted')!.textContent = 'Balances and positions belong to your selected trading wallet. Connecting MetaMask does not change your Mera login.';
    main.querySelector('.account .pill')!.textContent = 'On-chain balances';
    main.querySelector('#setup-status')!.textContent = 'Fund your MetaMask account with test AUSD and MON. Mera is only for sign-in.';
    main.querySelector('.wallet-help p:last-child')!.textContent = 'Connect MetaMask and confirm transactions in its wallet window.';
    main.querySelector('label[for="wallet-provider"]')!.textContent = 'Trading wallet';
    if (publicTestnet) {
      (main.querySelector('#setup-wallet') as HTMLElement).hidden = true;
      (main.querySelector('#setup-wallet') as HTMLElement).style.display = 'none';
      main.querySelector('.quote-footer')!.textContent = 'Review your quote to approve AUSD or trade. Public Monad testnet assets only.';
      main.querySelector('#setup-status')!.textContent = 'Use your connected MetaMask balance. The funding panel above funds MetaMask; Mera is for account access only.';
      main.querySelector('.wallet-help')!.innerHTML = '<summary>Monad testnet network</summary><p>Chain ID 10143. RPC https://testnet-rpc.monad.xyz. Use public test assets only.</p>';
    }
    main.querySelector('.trading > .caption')!.textContent = 'Confirm every approval, trade and redemption in MetaMask.';
    // Progressive disclosure keeps conversion and settlement available without
    // making the first trade compete with every advanced action.
    for (const heading of Array.from(main.querySelectorAll('.trading h3'))) {
      const details = document.createElement('details'); details.className = 'advanced-action';
      const summary = document.createElement('summary'); summary.textContent = heading.textContent;
      details.append(summary); heading.before(details);
      let node = heading.nextElementSibling;
      while (node && node.tagName !== 'H3' && node.id !== 'review-details') { const next = node.nextElementSibling; details.append(node); node = next; }
      heading.remove();
    }
    // Keep review, confirmation and receipt tracking next to the primary action.
    // Advanced actions keep their existing controllers and shared submission lock.
    const advanced = main.querySelector('.advanced-action')!;
    for (const id of ['review-details', 'confirm-trade', 'cancel-review', 'execution-status', 'execution-hash', 'replacement-area', 'check-execution', 'clear-tracking']) {
      advanced.before(main.querySelector('#' + id)!);
    }
    if (market === 'learning') {
      (main.querySelector('.book') as HTMLElement).style.display = 'none';
      (main.querySelector('.advanced-action') as HTMLElement).style.display = 'none';
      const requirement = main.querySelector('#liability')!.parentElement!;
      requirement.querySelector('.eyebrow')!.textContent = 'COLLATERAL REQUIREMENT';
      requirement.querySelector('.muted')!.textContent = 'Covers payouts and the learning pricing reserve';
    }
    const style = document.createElement('style'); style.textContent = dashboardCss.replace(':root', ':host') + '\n' + workspaceCss;
    shadow.replaceChildren(style, main);
    main.setAttribute('data-panel', host.current!.dataset.panel || 'trade');
    const unmount = mountDashboard(shadow, { account: account ? rememberedTradingWallet(account) || undefined : undefined, consumer: true, credentials: 'same-origin',
      marketId: market, onBusy, verifyWallet: async (p, wallet) => {if(!account)throw Error('Sign in first.');await linkTradingWallet(p,account,wallet);},
      onWallet: selected => { if (account && selected) { try { sessionStorage.setItem(walletKey(account), selected); sessionStorage.setItem(tradingWalletKey(account), selected); } catch { /* Optional view preference. */ } } },
      providers: [] });
    return () => { unmount(); };
  }, [account, controller, state.method, market, onBusy]);
  useEffect(() => { host.current?.shadowRoot?.querySelector('main')?.setAttribute('data-panel', panel); }, [panel]);
  return <div ref={host} data-panel={panel} className="core-market" />;
}

export default function Workspace() {
  const { controller, state } = useAuth();
  const [location, navigate] = useLocation();
  const [accountPanel, setPanel] = useState<Panel>('trade');
  const pilotPage = location === '/events';
  const portfolioPage = location === '/portfolio';
  const panel = portfolioPage ? 'positions' : accountPanel;
  const [copied, setCopied] = useState(false);
  const [market, setMarket] = useState<Market>(() => {
    try { const saved = sessionStorage.getItem('flurbo.trading.market'); return publicTestnet && (saved === 'learning' || saved === 'pilot') ? saved : 'original'; }
    catch { return 'original'; }
  });
  const [marketBusy, setMarketBusy] = useState(false);
  useEffect(() => {
    if (pilotPage) {
      setMarket('pilot');
      try { sessionStorage.setItem('flurbo.trading.market', 'pilot'); } catch { /* View preference only. */ }
    }
  }, [pilotPage]);
  const address = state.address;
  const tabs = [{ key: 'markets', label: 'Markets', icon: Layers3, href: '/markets' }, { key: 'trade', label: 'Explore & trade', icon: Layers3, href: '/account' }, { key: 'positions', label: 'Portfolio', icon: Wallet, href: '/portfolio' }, { key: 'events', label: 'Real events', icon: Layers3, href: '/events' }] as const;
  return <main id="main" tabIndex={-1} className="consumer-workspace">
    <aside className="workspace-sidebar">
      <Link className="workspace-back" href="/"><ArrowLeft size={16} /> Back to the idea</Link>
      <span className="eyebrow">Your workspace</span>
      <nav aria-label="Workspace">{tabs.map(({key,label,icon: Icon,href}) => <Link key={key} href={href} aria-disabled={marketBusy || undefined} aria-current={location === href && (key !== 'trade' || accountPanel === 'trade') ? 'page' : undefined} onClick={event => { if (marketBusy) event.preventDefault(); else setPanel('trade'); }}><Icon size={18}/>{label}{location === href && <span className="workspace-nav-dot"/>}</Link>)}<button disabled={marketBusy} aria-current={!portfolioPage && !pilotPage && accountPanel === 'activity' ? 'page' : undefined} onClick={() => { setPanel('activity'); navigate('/account'); }}><Activity size={18}/>Activity & network</button></nav>
      <div className="workspace-note"><span className="eyebrow">One shared pool</span><p>Separate ideas.<br/><em>Connected possibilities.</em></p><span>{(pilotPage || market === 'pilot') ? 'Official-source pilot. Named testnet reviewers. Test assets only.' : publicTestnet ? 'Synthetic events on public Monad testnet. Test assets only.' : 'Synthetic events on a local Monad fork. Test assets only.'}</span></div>
      {address && <button className="workspace-signout" onClick={() => { void controller.signOut('Signed out. Your wallet and passkey remain yours.'); }}><LogOut size={15}/> Sign out</button>}
    </aside>
    <div className="workspace-body">
      <header className="workspace-heading"><div><span className="eyebrow">Flurbo / {pilotPage ? 'Real events' : panel === 'trade' ? 'Make your move' : panel === 'positions' ? 'Keep the bigger picture' : 'Follow the details'}</span><h1>{pilotPage ? <>Questions with <em>real outcomes.</em></> : panel === 'trade' ? <>A view worth <em>combining.</em></> : panel === 'positions' ? <>Your piece of <em>the picture.</em></> : <>Every move, <em>in view.</em></>}</h1><p>{pilotPage ? 'Explore official-source questions and follow every step of resolution.' : panel === 'trade' ? 'Choose the outcomes you believe in. Get one price from one shared pool.' : panel === 'positions' ? 'Follow your holdings and what they pay when the outcome is known.' : 'Check transactions, pool contracts and settlement on Monad.'}</p></div><span className="workspace-network"><i/> {publicTestnet ? 'Monad testnet' : 'Local test market'}</span></header>
      <section className="workspace-identity" aria-label="Account access">
        <div className="identity-symbol"><Wallet size={20}/></div>
        <div className="identity-copy"><span className="eyebrow">{address ? 'Your Flurbo account / Mera' : 'Make yourself at home'}</span>{state.restoring ? <p>Restoring your session...</p> : address ? <><button title="Copy full account address" onClick={async () => { try { await navigator.clipboard.writeText(address); setCopied(true); } catch { setCopied(false); } }} className="identity-address">{address.slice(0, 8)}...{address.slice(-6)} {copied ? <Check size={14}/> : <Copy size={14}/>}</button><span className="identity-caption">Signed in with Mera. Connect MetaMask below to trade.</span></> : <p>Sign in with Mera to open your Flurbo account.</p>}</div>
        {!address && <Link href="/login" className="button button-dark">Sign in <ArrowUpRight size={16}/></Link>}
      </section>
      {state.error && <p role="alert" className="auth-error">{state.error}</p>}
      {state.notice && <p role="status" className="auth-feedback">{state.notice}</p>}
      {publicTestnet && address && !portfolioPage && <Funding key={address + state.method}/>}
      {publicTestnet && !pilotPage && <section className="workspace-market" aria-label="Trading market">
        <label htmlFor="trading-market">Market</label>
        <select id="trading-market" value={market} disabled={marketBusy} onChange={event => {
          const next = event.target.value as Market;
          try { sessionStorage.setItem('flurbo.trading.market', next); } catch { /* The selected market still works for this visit. */ }
          setMarketBusy(false); setMarket(next);
        }}>
          <option value="original">Original pool</option><option value="learning">Learning pool</option><option value="pilot">Real-event pilot</option>
        </select>
        <p className="auth-help">{market === 'pilot' ? 'Separate real-event pool with official-source questions and a named testnet reviewer panel. Publication requires verified deployment.' : market === 'learning' ? 'Synthetic test market with funded operator price updates. Its positions and pool allowance are separate from the original pool.' : 'Original synthetic market. Your existing positions remain here.'} AUSD wallet funds can be used across these pools. Positions and allowances are separate.</p>
        {marketBusy && <p className="auth-help">Finish or cancel the review, or resolve the pending transaction, before switching markets.</p>}
      </section>}
      {pilotPage ? <Pilot key={`pilot:${address}`} namespace="pilot" onBusy={setMarketBusy}/> : address && portfolioPage ? <AccountPortfolio key={address+market+location} account={address} namespace={market}/> : market === 'pilot' ? <Pilot key={`pilot-market:${address}`} namespace="pilot" onBusy={setMarketBusy}/> : <CoreMarket key={`market:${market}`} account={address} panel={panel} market={market} onBusy={setMarketBusy}/>}
      {publicTestnet && panel === 'activity' && !pilotPage && market !== 'pilot' && <LearningComparison key={`comparison:${address}`}/>}
      {publicTestnet && panel === 'activity' && !pilotPage && market !== 'pilot' && <LearningPool key={`pool:${address}`}/>}
      <footer className="workspace-footer"><span>One pool. More possibilities.</span><span>{(pilotPage || market === 'pilot') ? 'Monad testnet / Real-event pilot / Test AUSD' : publicTestnet ? 'Monad testnet / Test AUSD / Synthetic outcomes' : 'Local prototype / AUSD collateral / Synthetic outcomes'}</span></footer>
    </div>
  </main>;
}
