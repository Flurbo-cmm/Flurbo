import {useEffect,useState} from 'react';
import {appFetch} from '../platform-fetch';
import {ArrowUpRight} from 'lucide-react';

// Evidence is untrusted content. Render text, never HTML, and only link HTTPS sources.
export default function EvidenceDisclosure({namespace,hash,label}:{namespace:string;hash:string;label:string}){
  const [open,setOpen]=useState(false),[data,setData]=useState<any>(null),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  const url=`/api/${encodeURIComponent(namespace)}/evidence/${encodeURIComponent(hash)}`;
  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController();setError('');setData(null);
    void appFetch(url,{credentials:'same-origin',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])})
      .then(async response=>{if(!response.ok)throw Error();return response.json();})
      .then(value=>{if(!controller.signal.aborted)setData(value);})
      .catch(()=>{if(!controller.signal.aborted)setError('Evidence could not be loaded. Try again.');});
    return()=>controller.abort();
  },[open,url,retry]);
  let report:any=null;
  try{report=JSON.parse(data?.attachment||'null')?.report;}catch{}
  const source=typeof data?.sourceURL==='string'&&/^https:\/\//i.test(data.sourceURL)?data.sourceURL:null;
  return <details className="evidence-disclosure" onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>{label}</summary>
    {open&&<div>{error?<p role="alert" className="state-inline error">{error} <button className="text-link" onClick={()=>setRetry(n=>n+1)}>Retry</button></p>:!data?<p role="status" className="busy-text">Loading evidence...</p>:<>
      <p><strong>Proposed answer: {['Unset','No','Yes','Void'][data.outcome]||'Not specified'}</strong></p>
      {typeof data.statement==='string'&&<p>{data.statement}</p>}
      {report?.block&&<dl><dt>Ethereum block</dt><dd>{String(report.block.number)}</dd><dt>Gas used / gas limit</dt><dd>{String(report.block.gasUsed)} / {String(report.block.gasLimit)}</dd><dt>Transactions</dt><dd>{String(report.block.transactions)}</dd></dl>}
      {source&&<p><a className="text-link" href={source} target="_blank" rel="noreferrer">Open the original source <ArrowUpRight aria-hidden="true" strokeWidth={1.75}/></a></p>}
      <p className="market-caption">This is the evidence submitted with the proposed answer. The settlement panel shows the final result and challenge status.</p>
    </>}<a href={url} target="_blank" rel="noreferrer" className="text-link">View raw evidence record <ArrowUpRight aria-hidden="true" strokeWidth={1.75}/></a></div>}
  </details>;
}
