import {useEffect,useState} from 'react';
import {appFetch} from '../platform-fetch';

type Prefs={payouts:boolean;challenges:boolean;closing:boolean};
type State={enabled:boolean;email:string|null;preferences:Prefs};
const OPTIONS:[keyof Prefs,string,string][]=[
  ['payouts','Payout ready to collect','When results are final and you have test AUSD to collect, with one reminder 3 days later if it is still uncollected.'],
  ['challenges','Answer proposed for a question you hold','With the proposed answer and the deadline to challenge it if it is wrong.'],
  ['closing','Trading closes soon','About 2 hours before trading closes in a market where you hold shares.'],
];
async function call(input?:Prefs):Promise<State>{
  const response=await appFetch('/api/account/notifications',{method:input?'POST':'GET',credentials:'same-origin',cache:'no-store',redirect:'error',
    headers:input?{'Content-Type':'application/json'}:undefined,body:input?JSON.stringify(input):undefined,signal:AbortSignal.timeout(12000)});
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(result.error||'Your email choices could not be loaded.');
  return result;
}

// Email notices about the member's own positions. One email per member, never shared with anyone else.
export default function NoticeSettings(){
  const [state,setState]=useState<State|null>(null),[draft,setDraft]=useState<Prefs|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  useEffect(()=>{void call().then(v=>{setState(v);setDraft(v.preferences);}).catch(e=>setError(e.message));},[]);
  if(!state||!draft)return error?<section className="panel access-card" aria-label="Email notices"><h2>Email notices</h2><p role="alert" className="state-inline error">{error}</p></section>:null;
  const changed=OPTIONS.some(([k])=>draft[k]!==state.preferences[k]);
  async function save(){setBusy(true);setError('');setNotice('');try{const v=await call(draft!);setState(v);setDraft(v.preferences);setNotice('Saved.');}catch(e){setError(e instanceof Error?e.message:'Try again.');}finally{setBusy(false);}}
  return <section className="panel access-card notice-settings" aria-label="Email notices">
    <h2>Email notices</h2>
    <p>{state.email?<>Sent only to <strong>{state.email}</strong>, the address you verified when you requested access. Each email goes to you alone.</>:'There is no verified email on this account, so Flurbo cannot send you notices.'}</p>
    <fieldset disabled={busy||!state.email}>
      <legend className="sr-only">Choose your email notices</legend>
      {OPTIONS.map(([key,title,help])=><label key={key} className="check-row"><input type="checkbox" checked={draft[key]} onChange={e=>setDraft({...draft,[key]:e.target.checked})}/><span><strong>{title}</strong><small>{help}</small></span></label>)}
    </fieldset>
    {!state.enabled&&state.email&&<p className="access-note">Notices are not being sent yet. Your choices are saved for when they start.</p>}
    <div className="access-actions"><button className="btn btn-secondary" disabled={busy||!changed||!state.email} onClick={()=>void save()}>{busy?'Saving…':'Save email choices'}</button></div>
    {error&&<p role="alert" className="state-inline error">{error}</p>}{notice&&<p role="status" className="field-help">{notice}</p>}
  </section>;
}
