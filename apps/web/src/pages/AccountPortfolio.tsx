import {useEffect,useRef,useState} from 'react';
import {linkTradingWallet} from '../wallet-links';
import {forgetPortfolioSources,portfolioSources,type PortfolioSources} from '../portfolio-sources';
import {discoverWallets,type BrowserWallet} from '../auth/wallet-choice';
import AccountHoldings from './AccountHoldings';
import PortfolioDashboard from './PortfolioDashboard';
import type {MarketGroup} from '../market-directory';
import {useLoadGate} from '../loading/gates';

export default function AccountPortfolio({account,namespace,groups}:{account:string;namespace:string;groups?:MarketGroup[]}) {
  const [wallets,setWallets]=useState<string[]|null>(null),[error,setError]=useState(''),[tick,setTick]=useState(0),[busy,setBusy]=useState(false);
  const [sources,setSources]=useState<PortfolioSources|null>(null);
  const currentAccount=useRef(account);currentAccount.current=account;
  async function refreshSources(){
    // A refresh the member asked for always reads the current list.
    forgetPortfolioSources();
    try{const data=await portfolioSources();if(currentAccount.current!==account)return;
      if(data.account.toLowerCase()!==account.toLowerCase())throw Error('Account changed. Sign in again.');
      setError('');setSources(data);setWallets([...new Set([...data.wallets,...(data.agentWallets||[])])]);
    }catch(e){if(currentAccount.current===account)setError(e instanceof Error?e.message:'Portfolio sources could not be refreshed.');}
  }
  useLoadGate('portfolio-sources',{pending:!wallets&&!error,label:'Loading your portfolio'});
  const [providers,setProviders]=useState<BrowserWallet[]>([]);
  useEffect(()=>discoverWallets(w=>setProviders(old=>old.some(x=>x.provider===w.provider)?old:[...old,w])),[]);
  useEffect(()=>{const changed=()=>setTick(n=>n+1);window.addEventListener('flurbo:wallet-linked',changed);return()=>window.removeEventListener('flurbo:wallet-linked',changed);},[]);
  useEffect(()=>{const c=new AbortController();setError('');setWallets(null);
    void portfolioSources(c.signal).then(data=>{if(data.account.toLowerCase()!==account.toLowerCase())throw Error('Account changed. Sign in again.');if(!c.signal.aborted){setSources(data);setWallets([...new Set([...data.wallets,...(data.agentWallets||[])])]);}}).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();
  },[account,tick]);
  async function connect(){setBusy(true);setError('');try{
    const p=providers[0]?.provider;if(!p)throw Error('Open Flurbo in MetaMask or install its extension.');
    await p.request({method:'wallet_requestPermissions',params:[{eth_accounts:{}}]});
    const addresses=await p.request({method:'eth_requestAccounts'});
    if(!Array.isArray(addresses)||!addresses[0])throw Error('Select your MetaMask wallet.');
    await linkTradingWallet(p,account,addresses[0]);setTick(n=>n+1);
  }catch(e){setError(e instanceof Error?e.message:'Wallet linking failed.');}finally{setBusy(false);}}
  return <section className="account-portfolio" aria-label="Account portfolio">
    <div className="portfolio-account-identity"><span>Mera account</span><p className="address">{account}</p>{sources&&<span className="muted">Across {sources.wallets.length} trading {sources.wallets.length===1?'wallet':'wallets'}{sources.agentWallets?.length?` and ${sources.agentWallets.length} agent ${sources.agentWallets.length===1?'wallet':'wallets'}`:''}</span>}</div>
    {error&&<p role="alert" className="state-inline error">{error} <button className="btn btn-secondary btn-sm" onClick={()=>setTick(n=>n+1)}>Retry</button></p>}
    {!wallets&&!error&&<><p role="status" className="sr-only">Loading your portfolio…</p><div className="portfolio-summary-grid" aria-hidden="true">{[0,1,2].map(i=><article key={i}><span className="skeleton skeleton-line" style={{width:'40%'}}/><span className="skeleton portfolio-figure-skeleton"/></article>)}</div></>}
    {wallets?.length===0&&<div className="state-block"><p>Connect MetaMask to add your trading shares.</p><button className="btn btn-primary" disabled={busy} onClick={()=>void connect()}>{busy?'Check MetaMask…':'Connect MetaMask'}</button></div>}
    {wallets&&(groups?<PortfolioDashboard key={account+wallets.join(',')} account={account} wallets={wallets} groups={groups} manualWallets={sources?.wallets||[]} agentExecutions={sources?.agentExecutions} onRefreshSources={refreshSources}/>:<AccountHoldings key={account+namespace} account={account} wallets={sources?.wallets||[]} namespace={namespace}/>)}
  </section>;
}

