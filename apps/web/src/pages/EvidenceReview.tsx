import {useEffect,useRef,useState} from 'react';
import {appFetch} from '../platform-fetch';
import './markets.css';
import './evidence-review.css';

type Setup={operator:boolean;model:string|null;aiConfigured:boolean;events:{id:string;question:string}[]};
type Report={schema:string;question:string;pool:string;rulesHash:string;generatedAt:number;reportHash:string;
  assessment:{recommendation:string;reason:string;checks:string[]};
  evidence:{id:string;endpoint:string;payloadHash:string;status:number;body:string}[];
  ai:{status:string;model:string|null;promptVersion:string;explanation:null|{summary:string;cautions:string[]}};notice:string};

export default function EvidenceReview(){
  const [setup,setSetup]=useState<Setup|null>(null),[event,setEvent]=useState(''),[ai,setAI]=useState(false);
  const [report,setReport]=useState<Report|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const request=useRef<AbortController|null>(null);
  useEffect(()=>{const c=new AbortController();void appFetch('/api/evidence-beta',{credentials:'same-origin',cache:'no-store',signal:c.signal}).then(async r=>{
    const data=await r.json();if(!r.ok)throw Error(data.error);setSetup(data);setEvent(data.events[0]?.id||'');
  }).catch(()=>{if(!c.signal.aborted)setError('The evidence beta is unavailable. Markets and settlement monitoring are separate.');});return()=>{c.abort();request.current?.abort();};},[]);
  async function review(){
    const c=new AbortController();request.current=c;setBusy(true);setError('');setReport(null);
    try{const r=await appFetch('/api/evidence-beta',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({eventId:event,useAI:ai}),signal:AbortSignal.any([c.signal,AbortSignal.timeout(45000)])});
      const data=await r.json();if(!r.ok)throw Error('Report unavailable. Wait a minute and try again. No transaction was sent.');
      if(data.schema!=='flurbo.evidence-review.v1'||data.transactionSubmitted!==false||data.humanReviewRequired!==true)throw Error('Unexpected evidence report');
      if(!c.signal.aborted)setReport(data);
    }catch(e){if(!c.signal.aborted)setError(e instanceof Error?e.message:'Report unavailable');}
    finally{if(request.current===c){request.current=null;setBusy(false);}}
  }
  function download(){if(!report)return;const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='flurbo-evidence-'+report.reportHash+'.json';a.click();URL.revokeObjectURL(url);}
  return <main id="main" tabIndex={-1} className="markets-page evidence-review">
    <header className="market-heading"><span className="market-badge">Read-only beta</span><h1>Review the <em>evidence.</em></h1><p>Read the source, check the rules, then decide. This assistant cannot sign or settle a market.</p></header>
    <section className="portfolio-wallet">
      <h2>Official release questions</h2><p>Only the two published software-release questions are supported. Practice outcomes are scripted and are not AI forecasts.</p>
      {setup&&<><label>Question<select value={event} disabled={busy} onChange={e=>{setEvent(e.target.value);setReport(null);}}>{setup.events.map(e=><option key={e.id} value={e.id}>{e.question}</option>)}</select></label>
        <label className="evidence-ai-toggle"><input type="checkbox" checked={ai} disabled={busy||!setup.aiConfigured||!setup.operator} onChange={e=>setAI(e.target.checked)}/> Add an AI explanation</label>
        <p>{setup.aiConfigured?`Configured model: ${setup.model}. Public normalized release facts only are sent to the provider.`:'AI is not configured. Source checks still work; they are deterministic code, not model output.'}</p>
        {!setup.operator&&<p>The configured testnet operator can request reports. This protects the free-tier quota.</p>}
        <button className="button button-dark" disabled={busy||!event||!setup.operator} onClick={()=>void review()}>{busy?'Reading evidence...':'Prepare evidence report'}</button>
      </>}
    </section>
    {error&&<p role="alert">{error}</p>}
    {report&&<section className="portfolio-wallet" aria-label="Evidence report"><h2>{report.question}</h2>
      <h3>{report.assessment.recommendation==='YES'?'Candidate Yes for human review':'No recommendation: human review needed'}</h3><p>{report.assessment.reason}</p>
      <ul>{report.assessment.checks.map(c=><li key={c}>{c}</li>)}</ul>
      <h3>AI assistance</h3><p>{report.ai.status==='generated'?'Model-generated explanation. Check it against the source.':report.ai.status==='not-requested'?'No AI request was made.':'AI assistance was unavailable or failed validation. No model recommendation is shown.'}</p>
      {report.ai.explanation&&<><p>{report.ai.explanation.summary}</p><ul>{report.ai.explanation.cautions.map((c,i)=><li key={i}>{c}</li>)}</ul></>}
      <h3>Source and provenance</h3>{report.evidence.map(e=><div key={e.id}><a href={e.endpoint} target="_blank" rel="noreferrer">Official release API</a><p>HTTP {e.status||'unavailable'} · SHA-256 {e.payloadHash}</p><details><summary>Archived source response</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{e.body||'No response captured'}</pre></details></div>)}
      <p>Observed {new Date(report.generatedAt*1000).toLocaleString()}. Pool {report.pool}. Rules {report.rulesHash}.</p><p>{report.notice}</p>
      <button className="button button-outline" onClick={download}>Download review and evidence</button>
      <p>There is no automatic assertion button. Review source revisions, ambiguity and the current resolver deadlines before taking a separate action.</p>
    </section>}
  </main>;
}
