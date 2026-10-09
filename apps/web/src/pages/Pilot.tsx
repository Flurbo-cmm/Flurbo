import { SemanticReview } from '../components/SemanticReview';
import {marketQuestion} from '../showcase-copy';
import {challengeUnavailable} from '../challenge';
import { linkedWallets, linkTradingWallet } from '../wallet-links';
import { useEffect, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { formatUnits, parseUnits, type Hex } from 'viem';
import { useAuth } from '../auth/context';
import { describeClaim, walletKey, tradingWalletKey } from '../portfolio';
import { discoverWallets, type BrowserWallet } from '../auth/wallet-choice';
import {watchTradingWallet} from '../auth/trading-session';
import { readCheckout, restorableCheckout, markCheckoutVisited, saveCheckout, clearCheckout, assertCheckoutBinding, type CheckoutDraft } from '../checkout';
import { rememberConfirmedClaim } from '../pilot-claims';
import {encodeClaim, type ClaimRule} from '../../shared/claims.mjs';
import SegmentedControl from '../components/ui/SegmentedControl';
import TransactionSheet from '../components/ui/TransactionSheet';
import { sheetPhase } from '../sheet-state';
import QuantityStepper from '../components/ui/QuantityStepper';
import {shares} from '../format';
import CombinationBuilder from './CombinationBuilder';
import { semanticAcknowledgment, pilotRequest as request, submitPilot, checkPilotPending, readPilotPending as readPending, pendingKeyFor, validatePilotReview,
  priceImpact, type Provider, type PilotState, type PilotInput, type PilotReview, type PilotPending, type PilotNamespace, type HoldingWitness } from '../pilot';
import './portfolio.css';
import './pilot-layout.css';
import './pilot.css';

const labels=['Not proposed','NO','YES','VOID'];
const phases=['Awaiting evidence','Challenge window','Under review','Final result'];
const date=(seconds:string|number)=>new Date(Number(seconds)*1000).toLocaleString();
const cash=(atoms:string)=>formatUnits(BigInt(atoms),6);
export default function Pilot({onBusy,namespace='pilot',consumer,tradingClosed=false,challenge,payout,onTradeConfirmed,onTradingWalletChange}:{onTradingWalletChange?:(address:string)=>void;onTradeConfirmed?:()=>void;onBusy(value:boolean):void;namespace?:PilotNamespace;consumer?:{event:number;yes:boolean};tradingClosed?:boolean;challenge?:{event:number};payout?:{scope:number;mask:string;owners:string[];title:string}}) {
  const pilotRequest=<T,>(path:string,input?:unknown)=>request<T>(path,input,namespace);
  const readPilotPending=()=>readPending(namespace),pilotPendingKey=pendingKeyFor(namespace);
  const {controller,state:auth}=useAuth();
  const [restored]=useState(()=>{try{const draft=consumer&&auth.address?restorableCheckout(namespace,auth.address,readCheckout(namespace,auth.address),!!readPilotPending()):null;return draft?.event===consumer?.event&&draft?.yes===consumer?.yes?draft:null;}catch{return null;}});
  const [state,setState]=useState<PilotState|null>(null),[notice,setNotice]=useState('Loading the real-event pilot...');
  const [wallets,setWallets]=useState<BrowserWallet[]>([]),[choice,setChoice]=useState('0'),[owner,setOwner]=useState('');
  const [walletStatus,setWalletStatus]=useState('checking');
  const activeOwner=useRef('');
  const [semanticConsent,setSemanticConsent]=useState({review:null as PilotReview|null,phrase:''});
  const [busy,setBusy]=useState(false),[review,setReview]=useState<PilotReview|null>(null),[pending,setPending]=useState<PilotPending|null>(null);
  const semanticReady=review?.semanticAssessment?.status!=='collision'||semanticConsent.review===review&&semanticConsent.phrase===semanticAcknowledgment;
  const [storageError,setStorageError]=useState(false),[hash,setHash]=useState('');
  const [confirmedHash,setConfirmedHash]=useState(''),[approved,setApproved]=useState<PilotInput|null>(null);
  // Presentation only: remembers which notice came from a failed action so the ticket can style it as an error.
  const [failure,setFailure]=useState('');
  const [event,setEvent]=useState(challenge?.event??0),[outcome,setOutcome]=useState(challenge?0:2),[statement,setStatement]=useState(''),[source,setSource]=useState(''),[attachment,setAttachment]=useState('');
  const [now,setNow]=useState(()=>Date.now()/1000);
  const [stake,setStake]=useState<HoldingWitness|null>(null),[eligibilityNotice,setEligibilityNotice]=useState(''),[eligibilityCursor,setEligibilityCursor]=useState<number|null>(0);
  const [accountWallets,setAccountWallets]=useState<string[]|null>(null),[challengeAccountError,setChallengeAccountError]=useState(false);
  const [evidence,setEvidence]=useState<{hash:string;uri:string}|null>(null);
  const [legs,setLegs]=useState<number[]>(restored?.legs.slice().sort((a,b)=>a-b)||[consumer?.event??0]),[quantity,setQuantity]=useState(restored?.quantity||'1'),[side,setSide]=useState<string>(payout?'redeem':restored?.side==='sell'?'sell':'buy');
  const [payoutAmount,setPayoutAmount]=useState('');
  const [rule,setRule]=useState<ClaimRule>(restored?.rule||'AND'),[answers,setAnswers]=useState<Record<number,boolean>>(restored?.answers||(consumer?{[consumer.event]:consumer.yes}:{}));
  const [quoting,setQuoting]=useState(false),[quoteTick,setQuoteTick]=useState(0),[completed,setCompleted]=useState(false),[pollPaused,setPollPaused]=useState(false);
  const quoteVersion=useRef(0),polls=useRef(0);
  const [position,setPosition]=useState<{quantity:string;payoutAtoms:string|null}|null>(null);
  const provider=useRef<Provider|null>(null), generation=useRef(0), live=useRef(true), working=useRef(false), cleanup=useRef(()=>{}), reviewRef=useRef(review);
  reviewRef.current=review;
  const scope=payout?.scope??legs.reduce((v,i)=>v|2**i,0);
  const tradeLimit=state?.maxTradeQuantityAtoms&&/^[1-9][0-9]*$/.test(state.maxTradeQuantityAtoms)?BigInt(state.maxTradeQuantityAtoms):null;
  const overTradeLimit=['buy','sell'].includes(side)&&tradeLimit!==null&&/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(quantity)&&parseUnits(quantity,6)>tradeLimit;
  const quantityError=overTradeLimit?`This market allows up to ${formatUnits(tradeLimit!,6)} shares per trade. Enter ${formatUnits(tradeLimit!,6)} or fewer to get a price.`:'';
  let encodedMask='0';
  try{if(legs.length)encodedMask=encodeClaim({events:state?.manifest.publication.draft.events.length??4,rule:legs.length===1?'AND':rule,legs:legs.map(event=>({event,yes:answers[event]??true}))}).mask;}catch{/* Invalid stored input cannot become a quote or a transaction. */}
  const mask=payout?.mask??encodedMask;
  function save(value:PilotPending|null) {
    if(value) localStorage.setItem(pilotPendingKey,JSON.stringify(value)); else localStorage.removeItem(pilotPendingKey);
    setPending(value);
  }
  async function run(fn:()=>Promise<void>){if(working.current)return;working.current=true;setBusy(true);try{await fn();}catch(e){if(live.current){const message=e instanceof Error?e.message:'Request failed. Check tracking before retrying.';setNotice(message);setFailure(message);}}finally{working.current=false;if(live.current)setBusy(false);}}
  async function refresh(wallet=owner){ const version=generation.current; const result=await pilotRequest<PilotState>('status'+(wallet?'?wallet='+wallet:'')); if(live.current&&version===generation.current){setState(result);setNotice(challenge?'Challenge status updated.':payout?'Connect MetaMask to collect your payout.':'Pilot data loaded. Connect MetaMask to take part.');} }
  useEffect(()=>{ live.current=true; const stop=discoverWallets(wallet=>setWallets(old=>old.some(w=>w.provider===wallet.provider)?old:[...old,wallet])); void run(()=>refresh());
    try{setPending(readPilotPending());}catch(e){setStorageError(true);setNotice(String(e));}
    const sync=()=>{try{setPending(readPilotPending());}catch{setStorageError(true);}};
    window.addEventListener('storage',sync);
    return()=>{live.current=false;generation.current++;cleanup.current();stop();window.removeEventListener('storage',sync);};
  },[]);
  useEffect(()=>{
    const p=wallets[Number(choice)]?.provider;
    if(!p||!auth.address){setWalletStatus('disconnected');return;}
    return watchTradingWallet({provider:p,account:auth.address,links:linkedWallets,publish:value=>{
      if(!live.current)return;
      setWalletStatus(value.status);
      if(activeOwner.current===value.owner&&value.status!=='checking')return;
      const version=++generation.current;
      activeOwner.current=value.owner;provider.current=value.owner?p:null;
      reviewRef.current=null;setReview(null);setPosition(null);setOwner(value.owner);onTradingWalletChange?.(value.owner);
      if(value.owner){
        try{sessionStorage.setItem(walletKey(auth.address!),value.owner);sessionStorage.setItem(tradingWalletKey(auth.address!),value.owner);}catch{}
        setNotice('');
        void pilotRequest<PilotState>('status?wallet='+value.owner).then(result=>{if(live.current&&version===generation.current)setState(result);}).catch(()=>{if(live.current&&version===generation.current)setNotice('Wallet restored. Market data could not be refreshed.');});
      }
    }});
  },[wallets[Number(choice)]?.provider,auth.address]);
  useEffect(()=>{onBusy(busy||!consumer&&!!review||!!pending||storageError);return()=>onBusy(false);},[busy,review,pending,storageError,onBusy,!!consumer]);
  useEffect(()=>{setEvidence(null);},[event,outcome,statement,source,attachment]);
  useEffect(()=>{setStake(null);setEligibilityCursor(0);setEligibilityNotice('');},[owner,event]);
  useEffect(()=>{if(!challenge&&!payout)return;const timer=setInterval(()=>setNow(Date.now()/1000),1000);return()=>clearInterval(timer);},[!!challenge,!!payout]);
  useEffect(()=>{
    if(!challenge||!auth.address)return;
    const c=new AbortController();setChallengeAccountError(false);
    void linkedWallets(c.signal).then(value=>{if(!c.signal.aborted&&value.account.toLowerCase()===auth.address?.toLowerCase())setAccountWallets(value.wallets.map(w=>w.toLowerCase()));}).catch(()=>{if(!c.signal.aborted)setChallengeAccountError(true);});
    return()=>c.abort();
  },[!!challenge,auth.address,owner]);
  useEffect(()=>{
    if(!challenge)return;
    const timer=setInterval(()=>{if(document.hidden||working.current)return;const version=generation.current;
      void pilotRequest<PilotState>('status'+(owner?'?wallet='+owner:'')).then(value=>{if(live.current&&version===generation.current)setState(value);}).catch(()=>{});
    },15000);
    return()=>clearInterval(timer);
  },[!!challenge,owner]);
  useEffect(()=>{setPosition(null);},[owner,scope,mask]);
  useEffect(()=>{setCompleted(false);},[scope,mask,quantity,side]);
  useEffect(()=>{if(consumer&&auth.address)markCheckoutVisited(namespace,auth.address);},[!!consumer,namespace,auth.address]);
  useEffect(()=>{
    if(!consumer||!auth.address)return;
    try{
      if(completed)clearCheckout(namespace,auth.address);
      else saveCheckout(namespace,auth.address,{event:consumer.event,yes:consumer.yes,legs,answers,rule:legs.length===1?'AND':rule,quantity,side:side as CheckoutDraft['side'],walletKind:'browser',...(restored?.binding?{binding:restored.binding}:{})});
    }catch{setStorageError(true);setNotice('Your browser could not save this purchase. Enable site storage before continuing.');}
  },[!!consumer,auth.address,legs,answers,rule,quantity,side,choice,completed]);
  useEffect(()=>{
    if(!consumer)return;
    const version=++quoteVersion.current,controller=new AbortController();
    setReview(null);reviewRef.current=null;setQuoting(false);
    if(tradingClosed||state?.resolved||state&&Date.now()/1000>=state.manifest.publication.draft.closesAt||overTradeLimit||mask==='0')return;
    if(!owner||!provider.current||pending||completed||storageError)return;
    if(!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(quantity)||parseUnits(quantity,6)<=0n)return;
    const walletGeneration=generation.current;
    const timer=setTimeout(()=>{
      setQuoting(true);
      const input={owner,action:side,scope,mask,quantity:parseUnits(quantity,6).toString(),slippageBps:50};
      void request<PilotReview>('prepare',input,namespace,controller.signal).then(result=>{
        validatePilotReview(result);
        assertCheckoutBinding(restored,result.manifest);
        if(result.requested.owner.toLowerCase()!==owner||result.requested.action!==side||result.requested.scope!==scope||result.requested.mask!==mask||result.requested.quantity!==input.quantity)throw new Error('Quote differs from your prediction. Refresh the price.');
        if(live.current&&version===quoteVersion.current&&walletGeneration===generation.current){setReview(result);setNotice('Price ready. Confirm in your wallet when you are ready.');}
      }).catch(e=>{if(!controller.signal.aborted&&live.current&&version===quoteVersion.current)setNotice(e instanceof Error?e.message:'Price unavailable. Refresh the price.');})
        .finally(()=>{if(live.current&&version===quoteVersion.current)setQuoting(false);});
    },350);
    return()=>{clearTimeout(timer);controller.abort();};
  },[!!consumer,owner,scope,mask,quantity,side,pending,completed,storageError,quoteTick,overTradeLimit,tradingClosed,state?.resolved,state?.manifest.publication.draft.closesAt]);
  useEffect(()=>{
    if(!consumer||!review||busy||pending)return;
    const timer=setTimeout(()=>{
      reviewRef.current=null;setReview(null);
      setNotice('This price has expired. Refresh the price before confirming. No transaction was sent.');
    },Math.max(0,review.expiresAt*1000-Date.now()));
    return()=>clearTimeout(timer);
  },[!!consumer,review,busy,pending]);
  useEffect(()=>{polls.current=0;setPollPaused(false);},[pending?.hash]);
  useEffect(()=>{
    if((!consumer&&!challenge&&!payout)||!pending?.hash||pending.login!==auth.address||busy||pollPaused)return;
    const timer=setTimeout(()=>{polls.current++;void run(async()=>{try{await check();}catch(e){setPollPaused(true);throw e;}finally{if(polls.current>=40)setPollPaused(true);}});},2000);
    return()=>clearTimeout(timer);
  },[!!consumer,!!challenge,!!payout,pending,busy,pollPaused,auth.address]);
  async function connect(switchAccount=false){
    cleanup.current(); let version=++generation.current;
    activeOwner.current='';provider.current=null;reviewRef.current=null;setOwner('');onTradingWalletChange?.('');setReview(null);setPosition(null);
    const p:Provider|undefined=wallets[Number(choice)]?.provider;
    if(!p)throw new Error('Open this site in MetaMask’s browser or install the MetaMask extension, then reconnect.');
    if(switchAccount)await p.request({method:'wallet_requestPermissions',params:[{eth_accounts:{}}]});
    const accounts=await p.request({method:'eth_requestAccounts'}) as string[];
    version=generation.current;
    if(!Array.isArray(accounts)||!/^0x[0-9a-f]{40}$/i.test(accounts[0]||''))throw new Error('No wallet account returned');
    if(!auth.address)throw Error('Sign in first.');
    setNotice('Confirm the account link in MetaMask if requested.');
    await linkTradingWallet(p,auth.address,accounts[0],()=>live.current&&version===generation.current);
    await refresh(accounts[0]); if(!live.current||version!==generation.current)return;
    if(auth.address)try{sessionStorage.setItem(walletKey(auth.address),accounts[0].toLowerCase());sessionStorage.setItem(tradingWalletKey(auth.address),accounts[0].toLowerCase());}catch{ /* Optional read-only preference. */ }
    activeOwner.current=accounts[0].toLowerCase();provider.current=p;setOwner(activeOwner.current);setWalletStatus('connected');onTradingWalletChange?.(activeOwner.current);setNotice('');
  }
  async function prepare(input:Omit<PilotInput,'owner'>){
    if(!owner||!provider.current)throw new Error('Connect MetaMask first');
    if(challenge&&input.action==='dispute'){
      const fresh=await pilotRequest<PilotState>('status?wallet='+owner);
      setState(fresh);
      const reason=challengeUnavailable(fresh,event,owner);
      if(reason)throw new Error(reason);
      if(!input.stake&&!stake)throw Error('Check your account shares before challenging.');
      input={...input,stake:input.stake||stake!};
    }
    const version=generation.current; setReview(null);
    const result=await pilotRequest<PilotReview>('prepare',{...input,owner});
    validatePilotReview(result);
    if(consumer)assertCheckoutBinding(restored,result.manifest);
    if(payout&&(result.action!=='redeem'||result.requested.owner.toLowerCase()!==owner||result.requested.scope!==scope||result.requested.mask!==mask||result.requested.quantity!==input.quantity))throw Error('Payout review changed. Refresh before collecting.');
    if(live.current&&version===generation.current){setReview(result);setNotice(payout?'Check the payout amount, then confirm in MetaMask.':result.notice);}
  }
  async function publishEvidence(){
    if(!state) return;
    const version=generation.current;
    const result=await pilotRequest<{hash:string;uri:string}>('evidence',{eventId:state.manifest.publication.draft.events[event].id,outcome,statement,sourceURL:source,attachment});
    if(!live.current||version!==generation.current)throw Error('Wallet changed. Review your challenge again.');
    setEvidence(result);setNotice(challenge?'Evidence saved. Review your challenge below. Nothing has been submitted on chain.':'Public evidence saved. Review an assertion, dispute or vote below. Saving evidence does not submit an outcome.');
    return result;
  }
  async function checkEligibility(){
    const version=generation.current;
    setEligibilityNotice('Checking shares across your linked wallets...');
    try{
      const result=await pilotRequest<{eligible:boolean;stake:HoldingWitness|null;nextCursor:number|null}>('challenge-eligibility',{owner,event,cursor:eligibilityCursor??0});
      if(!live.current||version!==generation.current)return;
      setStake(result.stake);setEligibilityCursor(result.nextCursor);
      setEligibilityNotice(result.eligible?'Your account holds shares in this event.':result.nextCursor!==null?'More combinations remain to check. Select Review challenge again to continue.':'Your account has no qualifying shares in this event. You cannot challenge this answer.');
      return result.eligible?result.stake:null;
    }catch(e){setEligibilityNotice('Shares could not be verified. Retry the check before challenging.');throw e;}
  }
  async function reviewChallenge(){
    const version=generation.current;
    const fresh=await pilotRequest<PilotState>('status?wallet='+owner);
    if(!live.current||version!==generation.current)throw Error('Wallet changed. Reconnect before reviewing.');
    setState(fresh);
    const reason=challengeUnavailable(fresh,event,owner);
    if(reason)throw Error(reason);
    const witness=await checkEligibility();
    if(!witness)return;
    const saved=evidence||await publishEvidence();
    if(!saved||!live.current||version!==generation.current)return;
    await prepare({action:'dispute',event,outcome,evidenceHash:saved.hash,evidenceURI:saved.uri,stake:witness});
  }
  async function confirm(){
    if(consumer&&review)assertCheckoutBinding(restored,review.manifest);
    if(!review||!provider.current||!auth.address||pending||storageError)return;
    if(payout&&(review.action!=='redeem'||review.requested.scope!==scope||review.requested.mask!==mask||!payout.owners.includes(owner)))throw Error('Select the MetaMask wallet that holds these shares.');
    if(challenge&&review.requested.action==='dispute'){
      if(review.requested.event!==event||review.requested.outcome!==outcome||review.requested.evidenceHash!==evidence?.hash)throw Error('Your challenge changed. Review it again.');
      const fresh=await pilotRequest<PilotState>('status?wallet='+owner);
      setState(fresh);
      const reason=challengeUnavailable(fresh,event,owner);
      if(reason)throw Error(reason);
      if(!stake||!(await pilotRequest<{eligible:boolean}>('challenge-eligibility',{owner,event,stake})).eligible)throw Error('Your account no longer has qualifying shares. Check eligibility again.');
    }
    if(consumer&&(review.requested.owner.toLowerCase()!==owner||review.requested.action!==side||review.requested.scope!==scope||review.requested.mask!==mask||review.requested.quantity!==parseUnits(quantity,6).toString()))throw new Error('Your prediction changed. Wait for its new price before buying.');
    if(!navigator.locks)throw new Error('Web Locks support is required for submission tracking.');
    const r=review,p=provider.current,version=generation.current,login=auth.address;
    await navigator.locks.request('flurbo-pilot-submit',{ifAvailable:true},async lock=>{
      if(!lock||readPilotPending())throw new Error('Another pilot transaction is being tracked');
      try{await submitPilot(p,r,login,save,()=>live.current&&version===generation.current&&reviewRef.current===r&&controller.getSnapshot().address===login,{namespace,acknowledgment:{rulesDigest:r.semanticAssessment?.rulesDigest||'',phrase:semanticConsent.review===r?semanticConsent.phrase:''}});setNotice('Submitted. Check confirmation before another action.');}
      finally{setReview(null);}
    });
  }
  async function check(){
    const saved=readPilotPending();if(!saved)return;
    const result=await checkPilotPending(saved,namespace);
    if(JSON.stringify(readPilotPending())!==JSON.stringify(saved))throw new Error('Tracking changed in another tab');
    if(result==='confirmed'||result==='reverted'){
      if(result==='confirmed')rememberConfirmedClaim(namespace,saved);
      save(null);setPosition(null);setConfirmedHash(saved.hash||'');
      setApproved(!consumer&&result==='confirmed'&&saved.review.action==='approve'?saved.review.requested:null);
      if(consumer&&result==='confirmed'&&['buy','sell','redeem'].includes(saved.review.action)){setCompleted(true);onTradeConfirmed?.();}
      if(payout&&result==='confirmed'&&saved.review.action==='redeem'){setCompleted(true);onTradeConfirmed?.();}
      if(challenge&&result==='confirmed'&&saved.review.action!=='approve'){setCompleted(true);onTradeConfirmed?.();}
      const confirmed=result==='confirmed'?(saved.review.action==='approve'?'Token approval confirmed. The approved action has not been sent. Review it below.':'Exact transaction confirmed. Balances refreshed.'):'Transaction reverted. No successful action was confirmed.';
      try{
        await refresh();
        const request=saved.review.requested;
        if(result==='confirmed'&&['buy','sell','redeem'].includes(saved.review.action)&&request.scope===scope&&request.mask===mask&&owner===request.owner.toLowerCase())
          setPosition(await pilotRequest('position',{owner,scope,mask}));
        setNotice(confirmed);
        if(challenge&&result==='confirmed'&&saved.review.action==='approve'&&request.action==='dispute'&&request.event===event&&request.outcome===outcome&&evidence&&evidence.hash===request.evidenceHash){
          await prepare({action:'dispute',event,outcome,evidenceHash:evidence.hash,evidenceURI:evidence.uri,stake:request.stake});
        }
      }catch{setNotice(result==='confirmed'&&saved.review.action==='approve'?'Bond approval confirmed. The challenge has not been submitted. Review it again if the challenge period is still open.':result==='confirmed'?'Transaction confirmed, but balances could not refresh. Check Portfolio for your holdings; do not repeat the transaction.':'Transaction reverted. Data refresh failed; check the receipt before retrying.');}
    }
    else setNotice(result==='pending'?'Still pending. Do not submit again.':'Waiting for a second canonical confirmation.');
  }
  const disabled=busy||!consumer&&!!review||!!pending||storageError;
  const current=state?.cases[event];
  const operatorRun=state?.manifest.publication.reviewerControl==='single-operator';
  if(payout){
    const eligible=payout.owners.includes(owner);
    return <section className="portfolio-wallet pilot-form portfolio-payout" aria-label="Collect portfolio payout">
      <h3>Collect payout</h3><p>{payout.title}</p><p role="status">{busy?'Checking...':notice==='Loading the real-event pilot...'?'Loading payout details...':notice}</p>
      {!pending&&!completed&&<><div className="ticket-wallet"><span>{owner?`${owner.slice(0,6)}…${owner.slice(-4)}`:'MetaMask'}</span><button className="button button-outline" disabled={disabled} onClick={()=>void run(()=>connect(!!owner))}>{owner?'Switch wallet':walletStatus==='checking'?'Checking wallet...':walletStatus==='unlinked'?'Link selected wallet':'Connect MetaMask'}</button></div>
        {!owner&&<p>Connect the MetaMask wallet holding these shares. Each wallet receives its own payout.</p>}
        {owner&&!eligible&&<p>This wallet has no eligible payout for this holding. Switch to its owning MetaMask wallet.</p>}
        {!review&&<button className="button button-dark" disabled={busy||!eligible||storageError} onClick={()=>void run(async()=>{
          const position=await pilotRequest<{quantity:string;payoutAtoms:string|null;fraction:[string,string]|null}>('position',{owner,scope,mask});
          if(position.payoutAtoms===null||BigInt(position.payoutAtoms)<=0n||!position.fraction)throw Error('No payout is available for these shares in this wallet. Refresh your portfolio.');
          const units=BigInt(position.quantity)>100_000_000n?100_000_000n:BigInt(position.quantity);
          const value=units*BigInt(position.fraction[0])/BigInt(position.fraction[1]);
          if(value<=0n)throw Error('This quantity has no payable amount.');
          setPayoutAmount(value.toString());await prepare({action:'redeem',scope,mask,quantity:units.toString()});
        })}>Review payout</button>}
      </>}
      <TransactionSheet phase={sheetPhase({review:review&&!pending?review:null,pending,completed:false,walletRequest:false})} title={pending?'Checking your transaction':'Payout review'} hash={pending?.hash} onDismiss={pending?undefined:()=>setReview(null)}
        actions={pending?<button className="btn btn-secondary" disabled={busy||!pending.hash} onClick={()=>void run(check)}>Check confirmation</button>
          :review?<><button className="btn btn-ghost" disabled={busy} onClick={()=>setReview(null)}>Cancel review</button><button className="btn btn-primary" disabled={busy||now>=review.expiresAt} onClick={()=>void run(confirm)}>Confirm payout in MetaMask</button></>:null}>
        {review&&!pending&&<section className="ticket-review" aria-label="Payout review"><p>Collect <strong>{cash(payoutAmount)} test AUSD</strong> for {cash(review.requested.quantity!)} shares.</p><p className="market-caption">Up to 100 shares per confirmation. Maximum network fee: {formatUnits(BigInt(review.maximumFeeWei),18)} MON.</p>
          {now>=review.expiresAt&&<p>This review expired. Cancel and review again.</p>}</section>}
        {pending&&<section className="ticket-review"><p>{pending.hash?'You can reload safely. Do not submit another payout while this transaction is pending.':'Check MetaMask activity before retrying. A transaction may have been sent.'}</p>
          {!pending.hash&&<><label>Transaction hash<input value={hash} onChange={e=>setHash(e.target.value)}/></label><button className="button button-outline" onClick={()=>void run(async()=>{if(!/^0x[0-9a-f]{64}$/i.test(hash))throw Error('Paste a valid transaction hash');save({...pending,hash:hash.toLowerCase() as Hex});})}>Find transaction</button></>}</section>}
      </TransactionSheet>
      {completed&&<p role="status">Payout collected. Your portfolio has been refreshed.</p>}
      {confirmedHash&&<a href={`https://testnet.monadscan.com/tx/${confirmedHash}`} target="_blank" rel="noreferrer">View transaction</a>}
    </section>;
  }
  if(challenge){
    const unavailable=state?challengeUnavailable(state,event,owner,now):'Loading the proposed answer...';
    const intended=pending?.review.requested.action;
    const mine=!!current&&!!accountWallets?.includes(current.disputer.toLowerCase());
    const closed=!!current&&(current.phase>=2||current.phase===1&&Math.max(now,state!.snapshot.timestamp)>=Number(current.challengeUntil));
    const canCompose=!unavailable&&!pending&&!completed&&!review;
    const reviewExpired=!!review&&(now>=review.expiresAt||!!review.requested.authorization&&now>=Number(review.requested.authorization.deadline));
    return <section className="public-challenge pilot-form" aria-label="Challenge an answer">
      <h2>{mine?'Your challenge':unavailable?'Challenge status':'Challenge the proposed answer'}</h2>
      <p role="status">{busy?'Working...':notice==='Loading the real-event pilot...'?'Loading challenge details...':notice}</p>
      {state&&current&&<><p><strong>{marketQuestion(state.manifest.publication.draft.events[event])}</strong></p>
        <p>Proposed answer: <strong>{labels[current.proposal]}</strong>. Challenges close {date(current.challengeUntil)}.</p>
        {!closed&&<p>Bond: <strong>{cash(state.manifest.publication.bondAtoms)} test AUSD</strong>, plus network fees. You can lose the bond under the published dispute rules. The testnet panel is controlled by the Flurbo operator.</p>}</>}
      {unavailable&&<p role="status">{unavailable}</p>}
      {!pending&&(!unavailable||mine)&&<div className="ticket-wallet"><span>{owner?`${owner.slice(0,6)}…${owner.slice(-4)}`:'MetaMask'}</span><button className="button button-outline" disabled={disabled} onClick={()=>void run(()=>connect(!!owner))}>{owner?'Switch wallet':walletStatus==='checking'?'Checking wallet...':walletStatus==='unlinked'?'Link selected wallet':'Connect MetaMask'}</button></div>}
      {!unavailable&&<p className="market-caption">Shares in any linked wallet qualify. Review your challenge, then confirm it in MetaMask before the deadline.</p>}
      {!unavailable&&state&&!state.manifest.challengePolicy&&<p className="market-caption">This older pool enforces account eligibility in Flurbo only. Its deployed contract still permits direct challenges without a holdings check.</p>}
      {owner&&!unavailable&&!pending&&!review&&<p role="status">{eligibilityNotice}</p>}
      {mine&&current&&<section className="ticket-review" aria-label="Your submitted challenge"><h3>{current.phase===3?'Challenge resolved':'Challenge submitted'}</h3>
        <p>Your answer: <strong>{labels[current.counter]}</strong></p>
        <p>{current.phase===3?'Final answer: '+labels[current.result]:'Awaiting the testnet panel. Voting closes '+date(current.voteUntil)+'.'}</p>
        <a href={`/api/${namespace}/evidence/${current.counterEvidenceHash}`} target="_blank" rel="noreferrer">View your submitted evidence</a>
      </section>}
      {challengeAccountError&&<p role="status">Your account challenge record could not be checked. Reload to retry.</p>}
      {closed&&accountWallets!==null&&!challengeAccountError&&!mine&&!pending&&<p>No submitted challenge from your linked wallets is shown for this market. Saved evidence alone does not challenge an answer.</p>}
      {canCompose&&<fieldset disabled={disabled}>
        <legend>Your challenge</legend>
        <label>Correct answer<select value={outcome} onChange={e=>setOutcome(Number(e.target.value))}><option value={0}>Choose a different answer</option>{[1,2,3].filter(v=>v!==current?.proposal).map(v=><option key={v} value={v}>{labels[v]}</option>)}</select></label>
        <label>Why is the proposed answer wrong?<textarea maxLength={8000} value={statement} onChange={e=>setStatement(e.target.value)}/></label>
        <label>Supporting source URL<input type="url" value={source} onChange={e=>setSource(e.target.value)}/></label>
        <label>Evidence excerpt<textarea maxLength={12000} value={attachment} onChange={e=>setAttachment(e.target.value)}/></label>
        <p className="market-caption">Your explanation, source and Flurbo account address will be published with the evidence. Include public information only.</p>
        <p className="market-caption">At least 20 characters of explanation and a source URL are required. Your challenge is submitted only when its transaction confirms.</p>
        <button className="button button-dark" disabled={!owner||![1,2,3].includes(outcome)||outcome===current?.proposal||statement.trim().length<20||!source.trim()} onClick={()=>void run(reviewChallenge)}>Review challenge</button>
        {evidence&&<p><a href={evidence.uri} target="_blank" rel="noreferrer">Read your saved evidence</a> · Saving evidence does not submit a challenge.</p>}
      </fieldset>}
      {approved?.action==='dispute'&&!unavailable&&!review&&!pending&&<p>Bond approval confirmed. Review your challenge again to submit it. Approval alone does not challenge the answer.</p>}
      <TransactionSheet phase={sheetPhase({review:review&&!pending&&(!unavailable||review.requested.action!=='dispute')?review:null,pending,completed:false,walletRequest:false})}
        title={pending?'Checking your transaction':review?(review.action==='approve'?'Approve the challenge bond':review.action==='withdrawBond'?'Collect bond credit':'Confirm your challenge'):''} hash={pending?.hash} onDismiss={pending?undefined:()=>setReview(null)}
        steps={review?.requested.action==='dispute'?[{label:'Approve bond',current:review.action==='approve'},{label:'Submit challenge',current:review.action!=='approve'}]:undefined}
        actions={pending?<button className="btn btn-secondary" disabled={busy||!pending.hash} onClick={()=>void run(check)}>Check confirmation</button>
          :review?<><button className="btn btn-ghost" disabled={busy} onClick={()=>setReview(null)}>Cancel review</button><button className="btn btn-primary" disabled={busy||reviewExpired||review.requested.action==='dispute'&&!!unavailable} onClick={()=>void run(confirm)}>{review.action==='approve'?'Approve bond in MetaMask':review.action==='dispute'?'Submit challenge in MetaMask':'Confirm in MetaMask'}</button></>:null}>
      {review&&!pending&&(!unavailable||review.requested.action!=='dispute')&&<section className="ticket-review" aria-label="Challenge transaction review">
        {review.requested.action==='dispute'&&<><p>Your answer: <strong>{labels[review.requested.outcome!]}</strong>. Bond: {cash(review.manifest.publication.bondAtoms)} test AUSD.</p><p>{review.action==='approve'?'This only allows the resolver to take your bond. You will confirm the challenge separately.':'This submits your alternative answer and locks the bond.'}</p></>}
        <p className="market-caption">Maximum network fee: {formatUnits(BigInt(review.maximumFeeWei),18)} MON.</p>
        {review.requested.authorization&&<p className="market-caption">Eligibility expires {date(review.requested.authorization.deadline)}. If it expires, cancel this review and review again.</p>}
        {review.requested.action==='dispute'&&<p><a href={`/api/${namespace}/evidence/${review.requested.evidenceHash}`} target="_blank" rel="noreferrer">Read your saved evidence</a></p>}
        {reviewExpired&&<p>This review expired. Cancel and review again before the challenge deadline.</p>}
      </section>}
      {unavailable&&review?.requested.action==='dispute'&&!pending&&<button className="button button-outline" disabled={busy} onClick={()=>setReview(null)}>Close expired review</button>}
      {pending&&<section className="ticket-review"><p>{pending.hash?'Confirmation is checked automatically. You can reload without submitting again.':'Check MetaMask activity before retrying. A transaction may have been sent.'}</p>{intended!=='dispute'&&<p>This is an earlier {intended} transaction for this collection.</p>}
        {!pending.hash&&<><label>Transaction hash<input value={hash} onChange={e=>setHash(e.target.value)}/></label><button className="button button-outline" onClick={()=>void run(async()=>{if(!/^0x[0-9a-f]{64}$/i.test(hash))throw Error('Paste a valid transaction hash');save({...pending,hash:hash.toLowerCase() as Hex});})}>Find transaction</button></>}
      </section>}
      </TransactionSheet>
      {completed&&<p role="status">Transaction confirmed. The latest result is shown above.</p>}
      {confirmedHash&&<p><a href={`https://testnet.monadscan.com/tx/${confirmedHash}`} target="_blank" rel="noreferrer">View confirmed transaction</a></p>}
      {owner&&state?.wallet&&BigInt(state.wallet.credits)>0n&&<button className="button button-outline" disabled={disabled} onClick={()=>void run(()=>prepare({action:'withdrawBond'}))}>Collect {cash(state.wallet.credits)} test AUSD bond credit</button>}
      <button className="button button-outline" disabled={disabled} onClick={()=>void run(()=>refresh())}>Refresh challenge status</button>
    </section>;
  }
  if(consumer){
    const question=state?.manifest.publication.draft.events[consumer.event];
    if((tradingClosed||state?.resolved||state&&Date.now()/1000>=state.manifest.publication.draft.closesAt)&&!pending)return <div className="consumer-ticket closed-ticket"><h2>{state?.resolved?'This market has settled':'Trading has closed'}</h2><p>{state?.resolved?'See the final answer and evidence in the settlement panel. Your portfolio shows your result and any payout available.':'New trades are no longer available. Follow the settlement status here and your holdings in Portfolio.'}</p><a className="btn btn-primary" href="/portfolio">View portfolio</a></div>;
    const limit=tradeLimit!==null?Number(formatUnits(tradeLimit,6)):null;
    const reviewTitle=review?(review.action==='approve'?'Step 1 of 2: allow this payment':review.action==='buy'?'Your purchase':review.action==='sell'?'Confirm your sale':'Confirm your payout'):'';
    const reviewQuantity=review?cash(review.requested.quantity||'0'):'0';
    const consumerPhase=sheetPhase({review:review&&!completed?review:null,pending,completed,walletRequest:false}),sheetOpen=consumerPhase!=='closed';
    const failed=!busy&&!quantityError&&!!failure&&notice===failure&&notice!=='Wallet request rejected.';
    const statusLine=<p className={`ticket-status${failed?' ticket-status-error':''}`} role="status">{failed&&<TriangleAlert aria-hidden="true" strokeWidth={1.75}/>}{busy?'Working...':quantityError||consumerNotice(notice)}</p>;
    const refreshPrice=<button className="text-link ticket-refresh" disabled={busy||quoting||overTradeLimit} onClick={()=>setQuoteTick(n=>n+1)}>Refresh price</button>;
    return <div className="consumer-ticket">
      <div className="ticket-head"><h2>{legs.length>1?'Your combined prediction':'Your prediction'}</h2><p className="field-help">Each winning share pays 1 test AUSD. Choose your answer and number of shares below.</p></div>
      <div className="ticket-wallet">
        <div><strong className={owner?'mono':undefined}>{owner ? `${owner.slice(0,6)}…${owner.slice(-4)}` : 'MetaMask'}</strong>{owner&&state?.wallet&&<small>{cash(state.wallet.cash)} test AUSD</small>}</div>
        <button className={owner?"btn btn-secondary":"btn btn-primary"} disabled={disabled} onClick={()=>void run(()=>connect(!!owner))}>{owner?'Switch wallet':walletStatus==='checking'?'Checking wallet...':walletStatus==='unlinked'?'Link selected wallet':'Connect MetaMask'}</button>
      </div>
      {restored&&legs.length===1&&<p className="ticket-note">Your saved selection has been restored. Check the answers before confirming.</p>}
      {legs.length>1&&!pending&&!completed&&<p className="ticket-note ticket-combined" role="note"><strong>Combined prediction: {legs.length} answers.</strong> {restored?'Restored from your last visit. ':''}You are buying one combined position, not this answer alone. <button className="text-link" disabled={disabled} onClick={()=>{setLegs([consumer.event]);setRule('AND');}}>Buy only this answer</button></p>}
      {!pending&&!completed&&<div className="ticket-controls">
        <SegmentedControl label="Buy or sell" value={side==='sell'?'sell':'buy'} options={[{value:'buy',label:'Buy'},{value:'sell',label:'Sell'}]} onChange={value=>setSide(value)} disabled={disabled} block/>
        <SegmentedControl label="Your answer" value={(answers[consumer.event]??true)?'yes':'no'} options={[{value:'yes',label:'Yes'},{value:'no',label:'No'}]} onChange={value=>setAnswers(old=>({...old,[consumer.event]:value==='yes'}))} disabled={disabled} block/>
        <QuantityStepper label="Shares" value={quantity} onChange={setQuantity} max={limit} disabled={disabled} describedBy={limit!==null?'ticket-limit':undefined}/>
        {tradeLimit!==null&&['buy','sell'].includes(side)&&<p id="ticket-limit" className="field-help">Up to {formatUnits(tradeLimit,6)} shares per trade, including combinations.</p>}
        {mask==='0'?<p role="alert" className="state-inline error">This saved selection is unavailable. <button className="text-link" onClick={()=>{setLegs([consumer.event]);setRule('AND');}}>Reset prediction</button></p>:<CombinationBuilder state={state} base={consumer.event} legs={legs} answers={answers} rule={legs.length===1?'AND':rule} scope={scope} mask={mask} disabled={disabled} namespace={namespace} onLegs={next=>{setLegs(next);if(next.length===1||next.length<3&&rule==='AT_LEAST_TWO')setRule('AND');}} onAnswer={(event,yes)=>setAnswers(old=>({...old,[event]:yes}))} onRule={setRule}/>}
      </div>}
      {!sheetOpen&&statusLine}
      {!pending&&!completed&&owner&&!overTradeLimit&&!review&&<div className="ticket-quote-state"><p role="status" className="field-help">{quoting?'Getting your price...':'Enter your shares to get a price, or refresh the price below.'}</p>{quoting&&<span className="progress-line" aria-hidden="true"/>}</div>}
      {!pending&&!completed&&owner&&!review&&refreshPrice}
      <TransactionSheet mode="docked" phase={consumerPhase} hash={pending?.hash} dismissLabel={review&&!completed?'Cancel review':'Close'}
        title={pending?'Waiting for confirmation':review&&!completed?reviewTitle:side==='buy'?'Purchase complete':side==='sell'?'Sale complete':'Payout collected'}
        onDismiss={pending?undefined:review&&!completed?()=>{reviewRef.current=null;setReview(null);}:()=>setCompleted(false)} alert={sheetOpen?statusLine:undefined}
        steps={review&&!pending&&review.action==='approve'?[{label:'Allow payment',current:true},{label:`Buy ${shares(reviewQuantity)}`,current:false}]:undefined}
        actions={pending?(pollPaused?<button className="btn btn-primary" disabled={busy||!pending.hash} onClick={()=>{polls.current=0;setPollPaused(false);void run(check);}}>Check confirmation</button>:null)
          :completed?<><button className="btn btn-secondary" onClick={()=>{setCompleted(false);setLegs([consumer.event]);setRule('AND');setAnswers({[consumer.event]:consumer.yes});}}>Make another trade</button><a href="/portfolio" className="btn btn-primary">View portfolio</a></>
          :review?<>{refreshPrice}<button className="btn btn-primary btn-lg" disabled={busy||!!pending||!semanticReady} onClick={()=>void run(confirm)}>{review.action==='approve'?'Allow payment':review.action==='buy'?`Buy ${shares(reviewQuantity)}`:review.action==='sell'?'Sell shares':'Collect payout'}</button></>:null}>
      {completed&&!pending&&<section className="ticket-review ticket-done"><p>Your transaction is confirmed. There is no need to submit it again.</p><p className="market-caption"><a className="text-link" href="/access#notices">Email me when this settles</a></p></section>}

      {review&&!pending&&!completed&&<section className="ticket-review" aria-label="Transaction review"><p className="review-claim">{shares(reviewQuantity)} · {consumerClaim(review.requested,state)}</p>
        {review.action!=='redeem'&&<dl className="review-figures leaders">
          <div className="review-cost"><dt>{review.action==='sell'?'Receive at least':'Spend up to'}</dt><dd>{cash(review.action==='sell'?review.minimumReceivedAtoms!:review.amountAtoms)} test AUSD</dd></div>
          {['buy','approve'].includes(review.action)&&<><div><dt>Payout if correct</dt><dd>{reviewQuantity} test AUSD</dd></div><div><dt>Possible loss</dt><dd>Up to {cash(review.amountAtoms)} test AUSD + fees</dd></div></>}
          <div><dt>Price tolerance</dt><dd>0.5%</dd></div>
          {(()=>{const impact=priceImpact(review);return impact&&<div className={impact.bps>=500?'review-impact review-impact-large':'review-impact'}><dt>Average per share</dt><dd>{cash(impact.averageAtoms.toString())} test AUSD, {(Math.max(0,impact.bps)/100).toFixed(1)}% {review.requested.action==='sell'?'below':'above'} the price of one share</dd></div>;})()}
        </dl>}
        {(()=>{const impact=priceImpact(review);return impact&&impact.bps>=500&&<p className="field-help">Large for this pool's depth: each extra share moves the price. Fewer shares cost less per share.</p>;})()}
        <p>{review.action==='approve'?'First allow this payment in your wallet. We will check it automatically, then show the Buy button. Approval alone does not purchase shares.':'Review the amount, then confirm in your selected wallet.'}</p>
        <p className="market-caption">The quote includes the price impact of this trade size. Payout is not profit. A losing prediction pays 0; VOID may pay a fraction under the rules.</p>
        <details><summary>Payment details</summary><p>Maximum network fee: {formatUnits(BigInt(review.maximumFeeWei),18)} MON. Price tolerance: 0.5%.</p><p>Wallet <span className="address">{review.transaction.from}</span>. Review valid until {date(review.expiresAt)}.</p><p>Contract <span className="address">{review.transaction.to}</span></p></details>
        <SemanticReview review={review} phrase={semanticConsent.review===review?semanticConsent.phrase:''} onChange={phrase=>setSemanticConsent({review,phrase})}/></section>}
      {pending&&<section className="ticket-review ticket-pending"><span className="progress-line" aria-hidden="true"/><p>{pending.hash?'Your transaction was sent. We are checking confirmation automatically. You can reload this page without losing it.':'Check your wallet activity. A transaction may have been sent; do not repeat it.'}</p>{!pending.hash&&<div className="field"><label>Transaction hash<input value={hash} onChange={e=>setHash(e.target.value)}/></label><button className="btn btn-secondary" onClick={()=>void run(async()=>{if(!/^0x[0-9a-f]{64}$/i.test(hash))throw new Error('Paste a valid transaction hash');save({...pending,hash:hash.toLowerCase() as Hex});})}>Find transaction</button></div>}<p className="field-help">{pollPaused?'Automatic checks paused. Check again when ready.':'You do not need to click again.'}</p></section>}
      </TransactionSheet>
      {position&&<p className="ticket-position"><strong>{cash(position.quantity)} shares</strong> in your wallet. {position.payoutAtoms===null?'Payout follows settlement.':`${cash(position.payoutAtoms)} test AUSD to collect.`}</p>}
      {confirmedHash&&<p><a className="text-link" href={`https://testnet.monadscan.com/tx/${confirmedHash}`} target="_blank" rel="noreferrer">View transaction</a></p>}
      {question&&<details className="disclosure"><summary>How this market works</summary><p>{question.yesRule}</p><p>{question.noRule}</p><p>{state!.manifest.publication.draft.exceptionPolicy}</p><p>{state?.manifest.publication.mode==='rehearsal'?'These practice outcomes are scripted. ':''}The testnet dispute panel is controlled by Flurbo's operator.</p><a className="text-link" href={question.source.referenceUrl} target="_blank" rel="noreferrer">{state?.manifest.publication.mode==='ethereum-activity'?'Ethereum API documentation':'Read resolution source'}</a></details>}
    </div>;
  }
  return <div className="portfolio-view pilot-view">
    <section className="pilot-intro"><span className="eyebrow">{state?.manifest.publication.mode==='rehearsal'?'Scripted rehearsal / Test assets':'Real events / Test assets'}</span><h2>From a question <em>to an outcome.</em></h2><p>{state?.manifest.publication.mode==='rehearsal'?'A separate practice pool with scripted outcomes. These are not real-world predictions. Your real-event holdings stay in their original pool.':'One shared pool for this cluster. Official-source evidence, an open challenge period and a named testnet reviewer panel.'}</p>{state?.manifest.publication.mode==='rehearsal'&&<p><a href="/rehearsal-rules" target="_blank" rel="noreferrer">Read the fixed rehearsal instructions</a>. A: YES without a challenge. B: propose YES, challenge with NO, then two reviewers vote NO. C: no assertion, then VOID at its deadline. D: YES without a challenge.</p>}<p role="status" className="pilot-notice">{notice}</p><button className="button button-outline" disabled={busy} onClick={()=>void run(()=>refresh())}>Refresh pilot</button></section>
    {confirmedHash&&<p><a href={`https://testnet.monadscan.com/tx/${confirmedHash}`} target="_blank" rel="noreferrer">View the last checked transaction</a></p>}
    {approved&&<section className="portfolio-wallet pilot-form"><p>Approval grants token permission. It does not complete the {approved.action}.</p><button className="button button-dark" disabled={disabled||owner!==approved.owner.toLowerCase()} onClick={()=>void run(async()=>{const {owner:_owner,...input}=approved;await prepare(input);setApproved(null);})}>Review approved {approved.action}</button><p>Connect the same trading wallet if it is not already selected.</p></section>}
    <TransactionSheet phase={sheetPhase({review,pending,completed:false,walletRequest:false})} title={pending?'Follow your transaction.':review?(review.action==='approve'?'Approve token permission':review.action==='buy'?'Buy shares':review.action==='sell'?'Sell shares':'Confirm your action'):''} hash={pending?.hash} onDismiss={pending?undefined:()=>setReview(null)}
      actions={pending?<button className="button button-dark" disabled={busy||!pending.hash} onClick={()=>void run(check)}>Check confirmation</button>:review?<><button className="button button-outline" disabled={busy} onClick={()=>setReview(null)}>Cancel review</button><button className="button button-dark" disabled={busy||!!pending||!semanticReady} onClick={()=>void run(confirm)}>Confirm in wallet</button></>:null}>
    {review&&!pending&&<section className="portfolio-wallet pilot-form" aria-label="Transaction review">{review.requested.scope!==undefined&&<p>{describeClaim(review.requested.scope,Number(review.requested.mask))}: {cash(review.requested.quantity!)} shares.</p>}<p>{review.notice}</p><p>Wallet {review.transaction.from}</p><p>Contract {review.transaction.to}</p>{review.action==='sell'&&<p>Minimum test AUSD received: {cash(review.minimumReceivedAtoms!)}.</p>}<p>Maximum test AUSD permission or spend: {cash(review.amountAtoms)}. Maximum network fee: {formatUnits(BigInt(review.maximumFeeWei),18)} MON.</p>{review.requested.outcome&&<p>Event {(review.requested.event??0)+1}: {labels[review.requested.outcome]}. Evidence {review.requested.evidenceHash}</p>}<p>Review expires {date(review.expiresAt)}. If fees increase, a fresh review is required.</p><SemanticReview review={review} phrase={semanticConsent.review===review?semanticConsent.phrase:''} onChange={phrase=>setSemanticConsent({review,phrase})}/></section>}
    {pending&&<section className="portfolio-wallet pilot-form"><p>{pending.hash||'No hash returned yet. Check wallet activity before doing anything else.'}</p>{!pending.hash&&<><label>Transaction hash<input value={hash} onChange={e=>setHash(e.target.value)}/></label><button className="button button-outline" onClick={()=>void run(async()=>{if(!/^0x[0-9a-f]{64}$/i.test(hash))throw new Error('Paste a transaction hash');save({...pending,hash:hash.toLowerCase() as Hex});})}>Attach hash</button></>}</section>}
    </TransactionSheet>
    {state&&<>
      {operatorRun&&<section className="portfolio-wallet pilot-rules" aria-label="Resolution control"><h2>Operator-run testnet alpha</h2><p>All reviewer wallets are controlled by the Flurbo operator. {Math.floor(state.manifest.publication.reviewers.length/2)+1} matching votes are required, but these are not independent reviewers. The operator can determine disputed outcomes. Test assets only.</p><p>Operator: {state.manifest.publication.creator}</p></section>}
      <section className="portfolio-wallet"><div><label htmlFor="pilot-wallet">MetaMask wallet</label><select id="pilot-wallet" value={choice} disabled={disabled} onChange={e=>{if(e.target.value===choice)return;cleanup.current();generation.current++;activeOwner.current='';setChoice(e.target.value);setOwner('');provider.current=null;}}>{wallets.map((w,i)=><option key={i} value={i}>{w.name}</option>)}</select></div><button className="button button-dark" disabled={busy||!!review} onClick={()=>void run(()=>connect(!!owner))}>{owner?'Switch wallet':'Connect MetaMask'}</button>{owner&&<p className="portfolio-address">{owner}</p>}{state.wallet&&<p>{cash(state.wallet.cash)} test AUSD available. {state.wallet.reviewer?'Registered panel reviewer.':'Assertions and challenges require a test AUSD bond.'}</p>}</section>
      <section className="portfolio-wallet pilot-rules"><h2>{state.manifest.publication.draft.title}</h2><p>Trading closes {date(state.manifest.publication.draft.closesAt)}. Pool holds {cash(state.poolCash)} test AUSD against {cash(state.requiredCollateral)} required for payouts.</p><details><summary>Read the rules and panel</summary><p>{state.manifest.publication.draft.exceptionPolicy}</p><p>{state.manifest.publication.draft.disputePolicy}</p><p>Pool {state.manifest.pool}</p><p>Resolver {state.manifest.resolver}</p><p>{operatorRun?'One operator controls these reviewer wallets.':'The named reviewer panel is explicitly trusted.'} Test bonds and account creation do not provide decentralized security.</p></details></section>
      <div className="pilot-events">{state.manifest.publication.draft.events.map((e,i)=><article key={e.id} className="portfolio-wallet"><span className="eyebrow">Event {i+1} / {phases[state.cases[i].phase]}</span><h3>{marketQuestion(e)}</h3><p>Observation ends {date(e.observationEndsAt)}.</p><p>{state.cases[i].phase===3?`Final result: ${labels[state.cases[i].result]}`:state.cases[i].phase>0?`Proposed: ${labels[state.cases[i].proposal]}`:'Awaiting the observation window and evidence.'}</p><a href={e.source.referenceUrl} target="_blank" rel="noreferrer">{state.manifest.publication.mode==='ethereum-activity'?'Ethereum API documentation':'Official source'}</a><details><summary>YES and NO rules</summary><p>{e.yesRule}</p><p>{e.noRule}</p></details></article>)}</div>
      <section className="portfolio-wallet pilot-form"><h2>Build a combined view.</h2><p>Combine YES or NO outcomes with an AND or OR rule. Each winning share pays 1 AUSD. Void outcomes follow the rules above.</p><fieldset disabled={disabled}><legend>Events</legend>{state.manifest.publication.draft.events.map((e,i)=><label key={e.id}><input type="checkbox" checked={legs.includes(i)} disabled={!legs.includes(i)&&legs.length>=3} onChange={()=>setLegs(old=>old.includes(i)?old.filter(v=>v!==i):[...old,i].sort())}/>{marketQuestion(e)}</label>)}</fieldset>{legs.map(i=><label key={i}>Event {i+1} outcome<select disabled={disabled} value={(answers[i]??true)?'yes':'no'} onChange={e=>setAnswers(old=>({...old,[i]:e.target.value==='yes'}))}><option value="yes">YES</option><option value="no">NO</option></select></label>)}<label>Payout rule<select disabled={disabled} value={rule} onChange={e=>setRule(e.target.value as ClaimRule)}><option value="AND">All selected outcomes happen (AND)</option><option value="OR">Any selected outcome happens (OR)</option></select></label><div className="pilot-fields"><label>Buy or sell<select value={side} disabled={disabled} onChange={e=>setSide(e.target.value)}><option value="buy">Buy</option><option value="sell">Sell</option><option value="redeem">Redeem settled shares</option></select></label><label>Shares<input value={quantity} disabled={disabled} inputMode="decimal" onChange={e=>setQuantity(e.target.value)}/></label></div><p>Trading uses a 0.5% slippage limit. Approvals and trades are separate confirmations.</p><div className="pilot-actions"><button className="button button-dark" disabled={disabled||!owner||!legs.length} onClick={()=>void run(async()=>{if(!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(quantity))throw new Error('Enter a positive share amount with up to six decimals');await prepare({action:side,scope,mask,quantity:parseUnits(quantity,6).toString(),slippageBps:50});})}>Review {side}</button><button className="button button-outline" disabled={busy||!owner||!legs.length} onClick={()=>void run(async()=>{setPosition(await pilotRequest('position',{owner,scope,mask}));})}>Check these holdings</button></div>{position&&<p>{cash(position.quantity)} shares held. {position.payoutAtoms===null?'Settlement pending.':`${cash(position.payoutAtoms)} AUSD redeemable.`}</p>}</section>
      <details className="portfolio-wallet pilot-form"><summary>Propose, challenge or review an outcome</summary><h2>Make the result reviewable.</h2><label>Event<select value={event} disabled={disabled} onChange={e=>setEvent(Number(e.target.value))}>{state.manifest.publication.draft.events.map((e,i)=><option value={i} key={e.id}>{marketQuestion(e)}</option>)}</select></label>
        {current&&<p>{phases[current.phase]}. {current.phase===0?`Assertions close ${date(current.assertionDeadline)}.`:current.phase===1?`Challenges close ${date(current.challengeUntil)}.`:current.phase===2?`Voting closes ${date(current.voteUntil)}. NO ${current.votes[0]}, YES ${current.votes[1]}, VOID ${current.votes[2]}.`:`Result ${labels[current.result]}.`}</p>}
        {current&&[current.evidenceHash,current.counterEvidenceHash].filter(h=>!/^0x0{64}$/.test(h)).map(h=><p key={h}><a href={`/api/pilot/evidence/${h}`} target="_blank" rel="noreferrer">Read hosted evidence {h.slice(0,12)}</a></p>)}
        <p>Evidence links appear on the market page. A hosted copy is available only if it was archived on Flurbo.</p><label>Outcome<select value={outcome} disabled={disabled} onChange={e=>setOutcome(Number(e.target.value))}><option value={2}>YES</option><option value={1}>NO</option><option value={3}>VOID</option></select></label><label>Your explanation<textarea value={statement} maxLength={8000} disabled={disabled} onChange={e=>setStatement(e.target.value)} placeholder="Explain how the published source meets the committed rule."/></label><label>Source URL<input value={source} disabled={disabled} onChange={e=>setSource(e.target.value)} placeholder="https://..."/></label><label>Evidence excerpt or source-adapter output<textarea value={attachment} maxLength={12000} disabled={disabled} onChange={e=>setAttachment(e.target.value)}/></label><p>Saving publishes this evidence at a public content-addressed URL. Include public material only. A missing source response is not proof of NO.</p><button className="button button-outline" disabled={disabled||!owner} onClick={()=>void run(async()=>{await publishEvidence();})}>Save public evidence</button>
        {evidence&&<p><a href={evidence.uri} target="_blank" rel="noreferrer">View saved evidence</a></p>}
        <div className="pilot-actions">{(['assertOutcome','vote'] as const).map(action=><button key={action} className="button button-dark" disabled={disabled||!owner||!evidence|| (action==='assertOutcome'?current?.phase!==0:current?.phase!==2||!state.wallet?.reviewer||current.voted)} onClick={()=>void run(()=>prepare({action,event,outcome,evidenceHash:evidence!.hash,evidenceURI:evidence!.uri}))}>{action==='assertOutcome'?'Review assertion':'Review vote'}</button>)}</div>
        {current?.phase===1&&<p><a href={`/markets/${namespace}/${event}?challenge=1`}>Challenge through your account</a>. Shares are checked across your linked wallets.</p>}
        <p>Bond per assertion or challenge: {cash(state.manifest.publication.bondAtoms)} test AUSD. A quorum can finalize a dispute before the voting deadline.</p>
        <div className="pilot-actions"><button className="button button-outline" disabled={disabled||!owner||current?.phase===3} onClick={()=>void run(()=>prepare({action:'finalize',event}))}>Review deadline finalization</button><button className="button button-outline" disabled={disabled||!owner||state.delivered||!state.cases.every(c=>c.phase===3)} onClick={()=>void run(()=>prepare({action:'deliver'}))}>Review settlement delivery</button><button className="button button-outline" disabled={disabled||!owner||!state.wallet||state.wallet.credits==='0'} onClick={()=>void run(()=>prepare({action:'withdrawBond'}))}>Withdraw bond credit</button></div>
      </details>
    </>}

  </div>;
}

function consumerNotice(message:string){
  if(message==='Wallet request rejected.')return 'You cancelled the wallet confirmation. Nothing was submitted. Refresh the price when you want to try again.';
  if(message==='Submitted. Check confirmation before another action.')return 'Sent to the network. Confirmation is checked automatically.';
  if(message==='Pilot data loaded. Connect MetaMask to take part.')return 'Connect MetaMask to get started.';
  if(message==='Loading the real-event pilot...')return 'Loading your market...';
  if(message==='Wallet connected. Review and confirm each action separately.')return 'Your wallet is ready. Choose your answer and number of shares.';
  return message;
}

function consumerClaim(input:PilotInput,state:PilotState|null){
  if(input.scope===undefined||input.mask===undefined)return input.action;
  return describeClaim(input.scope,Number(input.mask)).replace(/([A-Z]) (YES|NO)/g,(_match,letter:string,answer:string)=>{
    const event=state?.manifest.publication.draft.events[letter.charCodeAt(0)-65];
    return event?`${marketQuestion(event)} ${answer==='YES'?'Yes':'No'}`:letter+' '+answer;
  });
}
