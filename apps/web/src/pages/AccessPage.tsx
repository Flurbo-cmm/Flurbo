import {useState} from 'react';
import {Link} from 'wouter';
import {CheckCircle2, Copy, Hourglass, LogOut} from 'lucide-react';
import {useAuth} from '../auth/context';
import type {Access} from '../auth/preview-access';
import TradingWallets from './TradingWallets';
import {AccessApplication,ApplicationReview} from './AccessApplication';
import MetricsSummary from './MetricsSummary';
import NoticeSettings from './NoticeSettings';
import PageHeader from '../components/PageHeader';
import './access.css';

export default function AccessPage({access,error,checking,refresh}:{access:Access|null;error:string;checking:boolean;refresh():Promise<void>}){
  const {state,controller}=useAuth();
  const [copied,setCopied]=useState('');
  async function copy(){try{await navigator.clipboard.writeText(state.address!);setCopied('Address copied');}catch{setCopied('Select the address to copy it.');}}
  const approved=!!access?.approved;
  return <main id="main" tabIndex={-1} className="page page-task access-page">
    <PageHeader title={approved?'Your account.':'Your place in the preview.'} lead="A Monad testnet experience for individual and combined predictions. Test assets only."/>
    <section className="panel access-card" aria-label="Your access status">
      <span className={`status ${approved?'':'status-muted'} market-badge-plain`}>{approved?<CheckCircle2 aria-hidden="true" strokeWidth={1.75}/>:<Hourglass aria-hidden="true" strokeWidth={1.75}/>}{approved?'Access approved':'Invite-based testnet'}</span>
      {(!access?.nativeApplications||access.approved)&&<><h2>{error?'Let’s check again':!access?'Checking your access':access.approved?'You’re ready to explore':'Your account is ready'}</h2>
      <p>{!access?(error?'Your application status is temporarily unavailable. Retry to load your saved status.':'Verifying access for your Mera account.'):access?.approved?'Browse questions, explore connections and follow your predictions in Portfolio.':access?.applicationUrl?'Request access using the account address below. Creating an account does not submit an application or approve access.':'Applications are not open yet. Keep this passkey to return to the same account when access becomes available.'}</p></>}
      {access?.nativeApplications&&!access.approved&&<AccessApplication key={state.address} refresh={refresh} checking={checking}/>}
      {access?.nativeApplications&&!access.approved?<p className="access-note">Account captured automatically · <span className="address" title={state.address||''}>{state.address?.slice(0,8)}…{state.address?.slice(-6)}</span></p>
        :<div className="access-identity"><span className="field-label">Your Mera account</span><code className="address">{state.address}</code><div className="cluster"><button className="text-link" onClick={()=>void copy()}><Copy aria-hidden="true" strokeWidth={1.75}/>Copy address</button><span role="status" className="field-help">{copied}</span></div></div>}
      {(!access?.nativeApplications||access.approved)&&<div className="access-actions">{access?.approved?<Link href="/markets" className="btn btn-primary">Explore markets</Link>:access?.applicationUrl?<a href={access.applicationUrl} target="_blank" rel="noreferrer" className="btn btn-primary">Request access</a>:null}<button className="btn btn-secondary" disabled={checking} onClick={()=>void refresh()}>{checking?'Checking…':access?.approved?'Refresh access':'Check access'}</button>{checking&&<span className="progress-line access-progress" aria-hidden="true"/>}</div>}
      {error&&<p role="alert" className="state-inline error">{error}</p>}
      {access&&!access.approved&&!access.applicationUrl&&!access.nativeApplications&&<div className="callout"><strong>Request access · Coming soon</strong><p>The application method is being prepared. Your account is saved; no application has been submitted.</p></div>}
      {access?.approved?<p className="access-note">Your passkey signs you in. Your linked MetaMask wallets hold your trading funds. <Link href="/fund">Get test funds</Link> · <Link href="/portfolio">View portfolio</Link></p>:access&&!access.nativeApplications?<p className="access-note">Approval is for this Mera account. Once approved, link MetaMask to trade. Never include a seed phrase, private key or passkey recovery details in an application.</p>:null}
      {!approved&&access?.nativeApplications&&<p className="access-note">Approval is tied to this Mera account. MetaMask is connected later, for trading only. Never include a seed phrase, private key or passkey recovery details in an application.</p>}
    </section>
    {access?.approved&&state.address&&<TradingWallets key={state.address} account={state.address}/>}
    {access?.approved&&state.address&&<NoticeSettings key={'notices-'+state.address}/>}
    {access?.testingTools&&<MetricsSummary key={'metrics-'+state.address}/>}
    {access?.nativeApplications&&access.testingTools&&<ApplicationReview key={'review-'+state.address}/>}
    <footer className="access-footer"><Link href="/docs" className="text-link">Read the guide</Link><button className="text-link" onClick={()=>void controller.signOut()}><LogOut aria-hidden="true" strokeWidth={1.75}/>Sign out</button></footer>
  </main>;
}
