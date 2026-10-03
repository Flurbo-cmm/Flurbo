import {marketQuestion,showcaseCopy} from '../showcase-copy';
import {portfolioSources} from '../portfolio-sources';
import EvidenceDisclosure from './EvidenceDisclosure';
import {useEffect,useState,useCallback,useRef} from 'react';
import {Link} from 'wouter';
import {formatUnits} from 'viem';
import {ArrowLeft,ArrowUpRight} from 'lucide-react';
import {useAuth} from '../auth/context';
import {pilotRequest,type PilotNamespace,type PilotState} from '../pilot';
import {rememberedTradingWallet} from '../portfolio';
import {settlementView} from '../market-detail';
import {settlementSources} from '../../shared/settlement-sources.mjs';
import {marketHref} from '../market-detail';
import Pilot from './Pilot';
import ShowcaseSource from './ShowcaseSource';
import WhatIf from './WhatIf';
import PriceHistory from './PriceHistory';
import StatusBadge,{type StatusKind} from '../components/ui/StatusBadge';
import Stepper,{type Step} from '../components/ui/Stepper';
import {useLoadGate} from '../loading/gates';
import {CLOSING_SOON_SECONDS,exactTime,relativeTime} from '../format';
import './market-detail.css';
const date=exactTime;
const cash=(v:string)=>formatUnits(BigInt(v),6);
const outcomes=['Unset','No','Yes','Void'];

function statusKind(title:string,phase:number,closesIn:number):StatusKind{
  if(title==='Open for predictions')return closesIn<CLOSING_SOON_SECONDS?'closing':'open';
  if(title==='Settled'||title==='Result confirmed')return 'settled';
  if(title==='Settling as void')return 'void';
  if(title==='Result disputed')return 'disputed';
  if(phase===1)return 'challenge';
  return 'waiting';
}

export default function MarketDetail({namespace,event}:{namespace:PilotNamespace;event:number}){
  const {state:auth}=useAuth(),[state,setState]=useState<PilotState|null>(null),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
  const [busy,setBusy]=useState(false),[positions,setPositions]=useState<{mask:string;quantity:string;payoutAtoms:string|null}[]|null>(null);
  const [positionError,setPositionError]=useState('');
  const [accountWallets,setAccountWallets]=useState<string[]>([]);
  const [challengeOpen,setChallengeOpen]=useState(()=>new URLSearchParams(window.location.search).get('challenge')==='1');
  const [now,setNow]=useState(()=>Date.now()/1000);
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()/1000),1000);return()=>clearInterval(timer);},[]);
  function toggleChallenge(open:boolean){setChallengeOpen(open);const url=new URL(window.location.href);if(open)url.searchParams.set('challenge','1');else url.searchParams.delete('challenge');window.history.replaceState(null,'',url);if(open)setTimeout(()=>document.getElementById('challenge-form')?.scrollIntoView({block:'start',behavior:'smooth'}),0);}
  const [quotes,setQuotes]=useState<{yes:string|null;no:string|null}|null>(null);
  const [owner,setOwner]=useState(()=>auth.address?rememberedTradingWallet(auth.address):'');
  const walletChanged=useCallback((address:string)=>setOwner(address),[]);
  const [initialYes]=useState(()=>new URLSearchParams(window.location.search).get('answer')!=='no');
  const confirmed=useCallback(()=>setAttempt(n=>n+1),[]);
  useEffect(()=>{const c=new AbortController();setError('');void pilotRequest<PilotState>('status',undefined,namespace,c.signal).then(s=>{if(!c.signal.aborted)setState(s);}).catch(()=>{if(!c.signal.aborted)setError('Market status could not be refreshed. Retry for a current view.');});return()=>c.abort();},[namespace,attempt]);
  useEffect(()=>{const c=new AbortController();setQuotes(null);void pilotRequest<{prices:{event:number;yes:string|null;no:string|null}[]}>('markets',undefined,namespace,c.signal).then(v=>{if(!c.signal.aborted)setQuotes(v.prices.find(p=>p.event===event)||null);}).catch(()=>{});return()=>c.abort();},[namespace,event,attempt]);
  useEffect(()=>{const timer=setInterval(()=>{if(!document.hidden&&!busy)setAttempt(n=>n+1);},60000);return()=>clearInterval(timer);},[busy]);
  useEffect(()=>{try{sessionStorage.setItem('flurbo.trading.market',namespace);}catch{}},[namespace]);
  useEffect(()=>{const c=new AbortController();setPositions(null);setPositionError('');
    void portfolioSources(c.signal).then(async links=>{
      if(links.account.toLowerCase()!==auth.address?.toLowerCase())throw Error('Account changed');
      if(!c.signal.aborted)setAccountWallets(links.wallets.map(w=>w.toLowerCase()));
      const wallets=[...new Set([...links.wallets,...(links.agentWallets||[])].map(w=>w.toLowerCase()))];
      const results=await Promise.all(wallets.map(wallet=>pilotRequest<{rows:{mask:string;quantity:string;payoutAtoms:string|null}[]}>('positions',{owner:wallet,claims:[{scope:2**event,mask:'2'},{scope:2**event,mask:'1'}]},namespace,c.signal)));
      const rows=['2','1'].map(mask=>{const items=results.map(r=>r.rows.find(row=>row.mask===mask));if(items.some(row=>!row))throw Error('Incomplete holdings');return {mask,quantity:items.reduce((n,r)=>n+BigInt(r!.quantity),0n).toString(),payoutAtoms:!items.length||items.some(r=>r!.payoutAtoms===null)?null:items.reduce((n,r)=>n+BigInt(r!.payoutAtoms!),0n).toString()};});
      if(!c.signal.aborted)setPositions(rows);
    }).catch(()=>{if(!c.signal.aborted)setPositionError('Your account holdings could not be refreshed. Retry shortly.');});return()=>c.abort();
  },[namespace,event,owner,attempt,auth.address]);
  const checkedSource=state?(settlementSources(state.manifest)[event]??null):null;
  const question=state?.manifest.publication.draft.events[event],view=state&&question?settlementView(state,event):null;
  const tradingClosed=!!state&&(state.resolved||now>=state.manifest.publication.draft.closesAt);
  const gate=useLoadGate('market',{pending:!state&&!error,label:'Loading this market'});
  // The ticket column stays in view only while it fits; a taller column scrolls with the page.
  const [stick,setStick]=useState(false);
  const observer=useRef<ResizeObserver|null>(null),recheck=useRef<()=>void>(()=>{});
  const sidebar=useCallback((node:HTMLElement|null)=>{
    observer.current?.disconnect();observer.current=null;
    if(!node||typeof ResizeObserver==='undefined')return;
    const check=()=>setStick(window.innerWidth>=1024&&node.scrollHeight<window.innerHeight-96);recheck.current=check;
    observer.current=new ResizeObserver(check);observer.current.observe(node);check();
  },[]);
  useEffect(()=>{const onResize=()=>recheck.current();window.addEventListener('resize',onResize);return()=>{window.removeEventListener('resize',onResize);observer.current?.disconnect();};},[]);
  useEffect(()=>{if(question)document.title=`${marketQuestion(question)} | flurbo`;},[question]);

  const c=state?.cases[event];
  const steps:Step[]=state&&view&&c?[
    {key:'trading',title:'Trading',meta:tradingClosed?`Closed ${date(view.closes)}`:`Closes ${relativeTime(view.closes,now)}, ${date(view.closes)}`,state:tradingClosed?'done':'current'},
    {key:'event',title:'Event observed',meta:`Observation ends ${date(view.observes)}`,state:now>=view.observes&&tradingClosed?'done':tradingClosed?'current':'upcoming'},
    {key:'answer',title:c.phase>=1?`Proposed answer: ${outcomes[c.proposal]}`:'Answer proposed',meta:c.phase>=1?undefined:view.lapsed?'No answer was proposed before the deadline, so this result will be void.':`Results expected from ${date(view.expectedFrom)}`,state:c.phase>=1?'done':now>=view.observes||view.lapsed?'current':'upcoming'},
    {key:'challenge',title:'Challenge window',meta:c.phase===1?`Challenge period ends ${date(view.deadline)}`:undefined,state:c.phase===1?'current':c.phase>=2?'done':'upcoming'},
    {key:'review',title:'Review, if challenged',meta:c.phase===2?`Dispute deadline ${date(view.deadline)}`:undefined,state:c.phase===2?'current':c.phase===3?'done':'upcoming'},
    {key:'final',title:c.phase===3?`Final answer: ${view.result}`:'Final answer',state:c.phase===3?'done':'upcoming'},
    {key:'payout',title:'Payouts',meta:state.delivered?<Link href="/portfolio" className="text-link">Collect in Portfolio</Link>:state.manifest.publication.draft.events.length>1?`Open after every question in the shared pool is settled, from ${date(view.payoutsFrom)}`:'Open after the shared pool is settled on-chain',state:state.delivered?'done':'upcoming'},
  ]:[];

  return <main id="main" tabIndex={-1} className="page markets-page market-detail" aria-busy={!state&&!error}>
    <nav className="detail-breadcrumb" aria-label="Breadcrumb"><Link href="/markets" className="link-back"><ArrowLeft aria-hidden="true" strokeWidth={1.75}/>All markets</Link><Link href="/fund" className="text-link">Get test funds</Link></nav>
    {error&&<p role="alert" className="state-inline error">{error}</p>}
    {!state&&!error&&<div className="detail-skeleton" aria-hidden="true"><span className="skeleton" style={{height:34,width:'70%'}}/><span className="skeleton skeleton-line" style={{width:'40%'}}/><div className="detail-columns"><span className="skeleton" style={{height:360}}/><span className="skeleton" style={{height:420}}/></div></div>}
    {!state&&!error&&<p role="status" className="sr-only">Loading this market...</p>}
    {!state&&!error&&!gate.covered&&<span className="progress-line" aria-hidden="true"/>}
    {state&&!question&&<div className="state-block"><h1>Market not found</h1><Link href="/markets" className="btn btn-primary">All markets</Link></div>}
    {question&&view&&state&&c&&<>
      <header className="detail-heading">
        <span className="chip">{state.manifest.publication.mode==='rehearsal'?'Scripted practice':'Real event'}</span>
        <h1>{marketQuestion(question)}</h1>
        {showcaseCopy(question)&&<p className="lead">{showcaseCopy(question)!.description}</p>}
        <dl className="detail-meta">
          <div><dt>Status</dt><dd><StatusBadge kind={statusKind(view.title,c.phase,view.closes-now)}>{error?'Status unavailable':view.title}</StatusBadge></dd></div>
          <div><dt>{tradingClosed?'Trading closed':'Trading closes'}</dt><dd><time dateTime={new Date(view.closes*1000).toISOString()}>{relativeTime(view.closes,now)}</time><small>{date(view.closes)}</small></dd></div>
          <div><dt>Results expected from</dt><dd><time dateTime={new Date(view.expectedFrom*1000).toISOString()}>{relativeTime(view.expectedFrom,now)}</time><small>{date(view.expectedFrom)}</small></dd></div>
          {quotes&&!tradingClosed&&<div><dt>Buy one share</dt><dd className="num">Yes {quotes.yes===null?'closed':Number(cash(quotes.yes)).toFixed(3)} · No {quotes.no===null?'closed':Number(cash(quotes.no)).toFixed(3)}<small>test AUSD, not probabilities</small></dd></div>}
        </dl>
      </header>
      <div className="detail-columns">
        <aside ref={sidebar} className={`detail-sidebar${stick?' is-sticky':''}`} aria-label="Trade and position">
          {challengeOpen?<section className="detail-panel" id="challenge-form"><Pilot key={'challenge'+namespace+event} namespace={namespace} challenge={{event}} onBusy={setBusy} onTradeConfirmed={confirmed}/><button className="btn btn-secondary" disabled={busy} onClick={()=>toggleChallenge(false)}>Back to market</button></section>
            :<section className="detail-panel detail-trade" aria-label="Trade this market">{quotes&&!tradingClosed&&<div className="detail-holdings detail-quotes"><div><span>Yes</span><strong>{quotes.yes===null?'Closed':cash(quotes.yes)+' AUSD'}</strong></div><div><span>No</span><strong>{quotes.no===null?'Closed':cash(quotes.no)+' AUSD'}</strong></div><p className="market-caption">Price per share, test AUSD. Exact quote before you confirm.</p></div>}<Pilot key={namespace+event} namespace={namespace} consumer={{event,yes:initialYes}} tradingClosed={tradingClosed} onBusy={setBusy} onTradeConfirmed={confirmed} onTradingWalletChange={walletChanged}/></section>}
          <section className="detail-panel detail-position" aria-label="Your position"><div className="panel-head"><h2>Your position</h2><Link href="/portfolio" className="text-link">Full portfolio <ArrowUpRight aria-hidden="true" strokeWidth={1.75}/></Link></div><p className="market-caption">Across your trading and agent wallets</p>
            {positionError?<p role="alert" className="state-inline error">{positionError}</p>:positions?<dl className="position-rows">{positions.map(p=><div key={p.mask}><dt>{p.mask==='2'?'Yes':'No'}</dt><dd><strong>{cash(p.quantity)} shares</strong><small>{p.payoutAtoms===null?(BigInt(p.quantity)===0n?'No position':tradingClosed?'Awaiting settlement':'Open for trading'):`${cash(p.payoutAtoms)} test AUSD to collect`}</small></dd></div>)}</dl>:<div className="position-rows" aria-hidden="true"><span className="skeleton" style={{height:40}}/><span className="skeleton" style={{height:40}}/></div>}
            {!positions&&!positionError&&<p role="status" className="sr-only">Loading your shares…</p>}
            <p className="market-caption">View results and collect payouts in your portfolio.</p>
          </section>
          <section className="detail-panel detail-thesis"><h2>Build your thesis</h2><p>Express a view about two questions. Compare it with the pool and see what each possible outcome would pay.</p><Link className="btn btn-secondary" href={marketHref(namespace,event)+'/thesis'}>Explore your view</Link></section>
        </aside>
        <div className="detail-primary">
          {showcaseCopy(question)&&<ShowcaseSource state={state} event={event} namespace={namespace}/>}
          <PriceHistory namespace={namespace} event={event} pool={state.manifest.pool} refresh={attempt}/>
          <details className="detail-panel detail-connect"><summary>Explore how these markets connect</summary><p className="market-caption">Read-only. Conditional and joint chances implied by the pool. It does not place a trade.</p><WhatIf namespace={namespace} manifest={state.manifest}/></details>
          <section className="detail-panel detail-settlement" aria-label="Settlement timeline"><div className="panel-head"><h2>From prediction to payout</h2><StatusBadge kind={statusKind(view.title,c.phase,view.closes-now)}>{view.title}</StatusBadge></div><p>{view.description}</p>
            <Stepper steps={steps} label="Settlement steps"/>
            {c.phase>0&&<div className="detail-challenge"><p>Proposed answer: <strong>{outcomes[c.proposal]}</strong></p>
              {['evidenceHash','counterEvidenceHash'].map((key,i)=>{const hash=c[key as 'evidenceHash'|'counterEvidenceHash'];return /^0x0{64}$/.test(hash)?null:<EvidenceDisclosure key={key} namespace={namespace} hash={hash} label={i?'Read challenge evidence':'Read proposed answer evidence'}/>;})}
              {c.phase===1&&<><p className="market-caption">Challenge bond: {cash(state.manifest.publication.bondAtoms)} test AUSD, plus network fees.</p>{Math.max(now,state.snapshot.timestamp)<Number(c.challengeUntil)?<button className="btn btn-primary" disabled={busy||challengeOpen||!!error} onClick={()=>toggleChallenge(true)}>Challenge proposed answer</button>:<p>The challenge period has ended.</p>}</>}
              {c.phase===2&&<p>The answer is disputed. The testnet reviewer panel decides the outcome.</p>}
              {c.phase===3&&<p>The result is final. Challenges are closed.</p>}
              {c.phase>=2&&accountWallets.includes(c.disputer.toLowerCase())&&!challengeOpen&&<button className="btn btn-secondary" disabled={busy} onClick={()=>toggleChallenge(true)}>View your challenge</button>}
            </div>}
            <details className="disclosure"><summary>Settlement details</summary><p>Observation ends {date(view.observes)}. Last checked {date(state.snapshot.timestamp)}.</p><p>Disputes or missing evidence can delay settlement. All events in this shared pool must resolve before payouts.</p></details>
            <div className="cluster"><button className="btn btn-secondary btn-sm" onClick={()=>setAttempt(n=>n+1)}>Refresh status</button></div>
          </section>
          <section className="detail-panel"><h2>What decides the answer?</h2><p>{state.manifest.publication.mode!=='rehearsal'?'The published source and the rules below determine the answer.':'This is a practice event with a scripted outcome, using test funds.'}</p>{!showcaseCopy(question)&&<a className="text-link" href={question.source.referenceUrl} target="_blank" rel="noreferrer">View source <ArrowUpRight aria-hidden="true" strokeWidth={1.75}/></a>}{checkedSource&&<div className="settlement-source"><h3>What settlement reads</h3><p>{checkedSource.request==='GET'?'Settlement reads exactly this record. You and your agents can open or fetch it too, before the result is decided.':'Settlement reads these Ethereum node endpoints. They answer JSON-RPC requests, so open them with an Ethereum client rather than a browser.'}</p><ul>{checkedSource.urls.map(url=><li key={url}><code>{url}</code></li>)}</ul><p className="field-help">Rule: {checkedSource.method}</p></div>}<details className="disclosure"><summary>Read the resolution rules</summary><p>Published question: {question.question}</p><h3>Yes</h3><p>{question.yesRule}</p><h3>No</h3><p>{question.noRule}</p><h3>If there is no clear result</h3><p>{state.manifest.publication.draft.exceptionPolicy}</p><p>{state.manifest.publication.draft.disputePolicy}</p><p>The current testnet dispute wallets are controlled by the Flurbo operator.</p></details></section>
          <details className="detail-panel"><summary>Shared pool details</summary><dl className="facts"><dt>Pool balance</dt><dd>{cash(state.poolCash)} test AUSD</dd><dt>Required payouts</dt><dd>{cash(state.requiredCollateral)} test AUSD</dd></dl><p className="market-caption">These totals cover the shared pool, not just this question.</p><a className="text-link" href={`https://testnet.monadscan.com/address/${state.manifest.pool}`} target="_blank" rel="noreferrer">View pool <ArrowUpRight aria-hidden="true" strokeWidth={1.75}/></a></details>
        </div>
      </div>
    </>}
    {!state&&error&&<button className="btn btn-primary" onClick={()=>setAttempt(n=>n+1)}>Retry</button>}
  </main>;
}
