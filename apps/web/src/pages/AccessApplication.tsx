import {useEffect,useState} from 'react';
import {appFetch} from '../platform-fetch';
import Stepper,{type Step} from '../components/ui/Stepper';

type Application={account:string;email:string|null;state:string;verified:boolean;revision:number;createdAt:string;notification:string};
type Result={application?:Application|null;applications?:Application[];message?:string;notification?:string};
async function request(action:string,input?:object,signal?:AbortSignal):Promise<Result>{
  const response=await appFetch('/api/account/application'+(action?'/'+action:''),{
    method:input?'POST':'GET',credentials:'same-origin',cache:'no-store',redirect:'error',
    headers:input?{'Content-Type':'application/json'}:undefined,body:input?JSON.stringify(input):undefined,
    signal:signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(input?30000:12000),
  });
  const result=await response.json();
  if(!response.ok)throw Error(result.error||'Your request could not be completed. Try again.');
  return result;
}

export function AccessApplication({refresh,checking}:{refresh():Promise<void>;checking:boolean}){
  const [application,setApplication]=useState<Application|null>(null),[loading,setLoading]=useState(true);
  const [loaded,setLoaded]=useState(false);
  const [email,setEmail]=useState(''),[code,setCode]=useState(''),[accepted,setAccepted]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [editing,setEditing]=useState(false),[withdrawing,setWithdrawing]=useState(false);
  useEffect(()=>{const abort=new AbortController();request('',undefined,abort.signal).then(v=>{
    if(abort.signal.aborted)return;setApplication(v.application||null);setEmail(v.application?.email||'');setLoaded(true);setLoading(false);
  }).catch(e=>{if(!abort.signal.aborted){setError(e.message);setLoading(false);}});return()=>abort.abort();},[]);
  async function act(action:string,input:object){
    if(busy)return;setBusy(true);setError('');setNotice('');
    try{const v=await request(action,input);setApplication(v.application||null);setEditing(false);setWithdrawing(false);setCode('');
      setNotice(v.message||(action==='verify'?'Email verified. Your request is ready for review.':action==='withdraw'?'Application withdrawn. Your contact email has been removed.':action==='submit'?'Check your inbox for a six-digit verification code.':''));
      if(action==='verify')await refresh();
    }catch(e){setError(e instanceof Error?e.message:'Please try again.');}finally{setBusy(false);}
  }
  async function checkStatus(){
    if(busy||checking)return;setBusy(true);setError('');setNotice('');
    try{const v=await request('');setApplication(v.application||null);setLoaded(true);
      if(!loaded)setEmail(v.application?.email||'');
      await refresh();
    }catch(e){setError(e instanceof Error?e.message:'Try again.');}finally{setBusy(false);}
  }
  if(loading)return <div className="application-loading" aria-busy="true"><span className="skeleton skeleton-line" style={{width:'40%'}}/><span className="skeleton skeleton-line" style={{width:'70%'}}/><p role="status" className="sr-only">Loading your application…</p></div>;
  const state=application?.state;
  const canApply=!application||state==='withdrawn'||editing;
  const verified=!!application?.verified&&state!=='withdrawn'&&!editing;
  const steps:Step[]=[
    {key:'account',title:'Account created',meta:'Your Mera passkey account',state:'done'},
    {key:'apply',title:canApply?'Request access':state==='unverified'?'Verify your email':'Email verified',meta:canApply?'Your email, for access updates only':state==='unverified'?'Enter the six-digit code':undefined,state:canApply||state==='unverified'?'current':'done'},
    {key:'review',title:state==='approved'?'Approved':state==='revoked'?'Access ended':state==='declined'?'Not selected this round':'Review',meta:state==='pending'&&verified?'The team reviews applications manually':undefined,state:!verified?'upcoming':state==='pending'?'current':'done'},
  ];
  return <section className="application-form" aria-label="Your access application" aria-busy={busy}>
    {loaded&&<Stepper steps={steps} label="Application progress" className="application-steps"/>}
    {!loaded?<div><h2>Your application couldn’t be loaded.</h2><p>Retry to check your saved status before making another request.</p></div>:canApply?<form onSubmit={e=>{e.preventDefault();void act('submit',{email,noticeAccepted:accepted});}}>
      <h2>Request your invitation.</h2><p>Leave your email. We’ll let you know when your account is approved.</p>
      <label htmlFor="application-email">Email address</label>
      <input id="application-email" type="email" autoComplete="email" maxLength={254} required value={email} onChange={e=>setEmail(e.target.value)} disabled={busy}/>
      <label className="application-consent check-row"><input type="checkbox" checked={accepted} onChange={e=>setAccepted(e.target.checked)} required disabled={busy}/><span>I understand Flurbo will use my email for application and access updates, and for notices about my own positions that I can turn off. <a href="/docs#application-data">How we use this data</a></span></label>
      <div className="access-actions"><button className="button button-dark" disabled={busy||!accepted}>{busy?'Saving…':'Request access'}</button>
      {editing&&<button type="button" className="text-link" onClick={()=>setEditing(false)}>Cancel</button>}</div>
    </form>:state==='unverified'?<form onSubmit={e=>{e.preventDefault();void act('verify',{code});}}>
      <h2>Check your email.</h2><p>Enter the code sent to <strong>{application.email}</strong>. It expires after 10 minutes.</p>
      <label htmlFor="application-code">Verification code</label>
      <input id="application-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,''))} disabled={busy}/>
      <div className="access-actions"><button className="button button-dark" disabled={busy||code.length!==6}>{busy?'Checking…':'Verify email'}</button><button type="button" className="text-link" disabled={busy} onClick={()=>void act('submit',{email:application.email,noticeAccepted:true})}>Send a new code</button><button type="button" className="text-link" disabled={busy} onClick={()=>setEditing(true)}>Change email</button></div>
      <small className="field-help">Allow one minute between codes. Check your spam folder too. Verification does not grant access.</small>
    </form>:<div role="status"><h2>{state==='pending'?'Your request is received.':state==='approved'?'Your invitation is ready.':state==='revoked'?'Access is no longer active.':'Not selected for this round.'}</h2>
      <p>{state==='pending'?'Your email is verified. We’ll email you when your account is approved.':state==='approved'?'Select Check application status to open your approved account.':'Your application has been reviewed. You can return here to check its status.'}</p>
      {state==='pending'&&<button className="text-link" disabled={busy} onClick={()=>setEditing(true)}>Change email</button>}
    </div>}
    {error&&<p role="alert" className="state-inline error">{error}</p>}{notice&&<p role="status" className="field-help">{notice}</p>}
    <div className="access-actions"><button className="btn btn-secondary" disabled={busy||checking} onClick={()=>void checkStatus()}>{busy||checking?'Checking…':'Check application status'}</button>{(busy||checking)&&<span className="progress-line access-progress" aria-hidden="true"/>}</div>
    {application&&state!=='withdrawn'&&state!=='approved'&&<details className="application-withdraw disclosure"><summary>Withdraw application</summary><p>This removes your application email. Your passkey and wallet holdings stay unchanged.</p><label className="application-consent check-row"><input type="checkbox" checked={withdrawing} onChange={e=>setWithdrawing(e.target.checked)}/>Remove my contact email</label><button className="btn btn-danger-outline" disabled={busy||!withdrawing} onClick={()=>void act('withdraw',{})}>Withdraw request</button></details>}
  </section>;
}

export function ApplicationReview(){
  const [rows,setRows]=useState<Application[]>([]),[offset,setOffset]=useState(0),[loaded,setLoaded]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [decision,setDecision]=useState<{account:string;revision:number;decision:string}|null>(null);
  async function load(page=offset){const v=await request('admin/list',{offset:page});setRows(v.applications||[]);setOffset(page);setLoaded(true);}
  async function run(fn:()=>Promise<void>){setBusy(true);setError('');setNotice('');try{await fn();}catch(e){setError(e instanceof Error?e.message:'Review could not be loaded.');}finally{setBusy(false);}}
  return <details className="application-review"><summary>Review access applications</summary><p>Operator only. Decisions take effect on the next access check.</p>
    <button className="button button-outline" disabled={busy} onClick={()=>void run(()=>load())}>{loaded?'Refresh applications':'Load applications'}</button>
    {loaded&&rows.length===0&&<p>No applications on this page.</p>}
    <div className="application-review-list">{rows.slice(0,25).map(a=><article key={a.account}><div><strong>{a.email||'Contact removed'}</strong><code>{a.account}</code><span>{a.state} · {new Date(a.createdAt).toLocaleDateString()}</span></div><div className="access-actions">
      {a.verified&&a.state!=='approved'&&<button className="button button-dark" disabled={busy} onClick={()=>setDecision({account:a.account,revision:a.revision,decision:'approved'})}>Approve</button>}
      {['pending','unverified'].includes(a.state)&&<button className="button button-outline" disabled={busy} onClick={()=>setDecision({account:a.account,revision:a.revision,decision:'declined'})}>Decline</button>}
      {a.state==='approved'&&<button className="button button-outline" disabled={busy} onClick={()=>setDecision({account:a.account,revision:a.revision,decision:'revoked'})}>Revoke access</button>}
      {a.notification==='pending'&&<button className="text-link" disabled={busy} onClick={()=>void run(async()=>{const v=await request('admin/notify',{account:a.account});setNotice(v.notification==='sent'?'Invitation email sent.':'Delivery is still pending.');await load();})}>Retry invitation email</button>}
      {a.notification==='needs_review'&&<small>Email delivery needs manual review. Check Resend before sending again.</small>}
    </div></article>)}</div>
    {decision&&<div className="application-decision" role="group" aria-label="Confirm access decision"><p>Set this account to <strong>{decision.decision}</strong>?</p><code>{decision.account}</code><div className="access-actions"><button className="button button-dark" disabled={busy} onClick={()=>void run(async()=>{const v=await request('admin/decide',decision);setDecision(null);setNotice(v.notification==='pending'?'Decision saved. Invitation email is pending; retry below.':'Decision saved.');await load();})}>Confirm decision</button><button className="button button-outline" disabled={busy} onClick={()=>setDecision(null)}>Cancel</button></div></div>}
    {loaded&&<div className="access-actions"><button className="text-link" disabled={busy||offset===0} onClick={()=>void run(()=>load(Math.max(0,offset-25)))}>Previous</button><button className="text-link" disabled={busy||rows.length<=25} onClick={()=>void run(()=>load(offset+25))}>Next</button></div>}
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  </details>;
}
