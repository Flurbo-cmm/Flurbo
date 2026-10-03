import {useEffect,useState} from 'react';
import {Link} from 'wouter';
import {appFetch} from '../platform-fetch';
import type {Access} from '../auth/preview-access';
export default function VisitorStatus({access}:{access:Access|null}){
  // Hold a sized placeholder until the application status is known, so the text never swaps after it appears.
  const [ready,setReady]=useState<'loading'|'open'|'closed'|'unknown'>('loading');
  useEffect(()=>{const c=new AbortController();void appFetch('/api/preview',{cache:'no-store',signal:AbortSignal.any([c.signal,AbortSignal.timeout(10000)])}).then(async r=>{if(!r.ok)throw Error();return r.json();}).then(v=>{if(!c.signal.aborted)setReady(v.nativeApplications===true||!!v.applicationUrl?'open':'closed');}).catch(()=>{if(!c.signal.aborted)setReady('unknown');});return()=>c.abort();},[]);
  if(access?.approved)return <section className="home-visitor-status" aria-label="Preview access"><h3>Your preview is ready</h3><p>Access approved. Explore markets, make predictions with test assets and follow your results in Portfolio.</p><div className="cluster"><Link href="/fund" className="text-link">Get test funds</Link></div></section>;
  if(ready==='loading')return <section className="home-visitor-status" aria-label="Preview access" aria-busy="true"><span className="skeleton skeleton-line" style={{width:'45%',height:18}}/><span className="skeleton skeleton-line" style={{width:'90%'}}/><span className="skeleton skeleton-line" style={{width:'70%'}}/></section>;
  return <section className="home-visitor-status" aria-label="Preview access"><h3>Invite-based testnet preview</h3><p>{ready==='open'?'Create a passkey account, then request access from your account page. Approved testers can explore markets, trade with test assets and follow their shares.':ready==='closed'?'Applications are not open yet. You can create your passkey account now and return when invitations become available.':'Create a passkey account to check access. Markets and portfolios are available to approved testers.'}</p><div className="cluster home-status-actions"><Link href="/access" className="text-link">Check your access</Link><Link href="/docs#getting-started" className="text-link">How to join</Link></div></section>;
}
