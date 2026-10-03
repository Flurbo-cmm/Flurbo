import {useEffect,useState} from 'react';
import {pilotRequest,type PilotNamespace} from '../pilot';

type Point={timestamp:number;blockNumber:string;prices:{event:number;yes:string|null;no:string|null}[]};
type History={pool:string;sampling:string;points:Point[]};
const stamp=(n:number)=>new Date(n*1000).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
const axisStamp=(n:number)=>new Date(n*1000).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
export default function PriceHistory({namespace,event,pool,refresh}:{namespace:PilotNamespace;event:number;pool:string;refresh:number}){
  const [data,setData]=useState<History|null>(null),[error,setError]=useState(false);
  const [range,setRange]=useState<'day'|'all'>('all');
  useEffect(()=>{const abort=new AbortController();setError(false);
    void pilotRequest<History>('price-history',undefined,namespace,abort.signal).then(value=>{
      if(value.pool!==pool)throw Error('Different collection');
      if(!abort.signal.aborted)setData(value);
    }).catch(()=>{if(!abort.signal.aborted)setError(true);});return()=>abort.abort();
  },[namespace,pool,event,refresh]);
  const points=(data?.points||[]).filter(p=>range==='all'||p.timestamp>=Date.now()/1000-86400);
  const start=points[0]?.timestamp||0,end=points.at(-1)?.timestamp||start;
  const ceiling=Math.max(1,...points.flatMap(p=>{const q=p.prices.find(q=>q.event===event);return [Number(q?.yes||0)/1e6,Number(q?.no||0)/1e6];}));
  const x=(time:number)=>points.length===1?330:55+(time-start)/Math.max(1,end-start)*550;
  const y=(atoms:string)=>220-Number(atoms)/1e6/ceiling*180;
  const quote=(p:Point,side:'yes'|'no')=>p.prices.find(q=>q.event===event)?.[side]??null;
  const gaps=points.flatMap((p,i)=>i&&p.timestamp-points[i-1].timestamp>600?[{from:points[i-1].timestamp,to:p.timestamp}]:[]);
  return <section className="detail-panel price-history" aria-label="Price history">
    <div className="detail-section-heading"><h2>Price history</h2><div className="price-ranges" role="group" aria-label="Chart time range">{(['day','all'] as const).map(v=><button key={v} type="button" aria-pressed={range===v} onClick={()=>setRange(v)}>{v==='day'?'24 hours':'All samples'}</button>)}</div></div>
    <p className="market-caption">Cost of one share in test AUSD. Not a probability.</p>
    {error?<p role="status" className="state-inline">Price history could not be refreshed. {data?'Showing previously loaded samples.':'Your trading balance is unaffected.'}</p>:!data?<><span className="skeleton" style={{height:220}} aria-hidden="true"/><p role="status" className="sr-only">Loading recorded prices…</p></>:null}
    {data?.sampling==='unavailable'&&!error&&<p role="status">The latest price sample is unavailable. Earlier observations remain below.</p>}
    {data?.sampling==='closed'&&<p className="market-caption">Trading has closed. Showing recorded prices before close.</p>}
    {data&&!points.length?<p>No recorded prices for this range yet. Samples begin when this market is viewed.</p>:points.length>0&&<>
      <div className="price-legend" aria-hidden="true"><span className="price-yes">Yes, solid</span><span className="price-no">No, dashed</span></div>
      <svg viewBox="0 0 660 270" role="img" aria-label="Sampled Yes and No one-share buy prices over time. Exact observations are in the table below.">
        {gaps.map(g=><rect key={g.from} x={x(g.from)} y="40" width={x(g.to)-x(g.from)} height="180" style={{fill:'var(--surface-sunken)'}} opacity=".7"><title>No observations recorded during this interval</title></rect>)}
        {[0,.5,1].map(f=><g key={f}><line x1="55" x2="605" y1={220-f*180} y2={220-f*180} style={{stroke:'var(--rule-strong)'}}/><text x="45" y={225-f*180} textAnchor="end">{(ceiling*f).toFixed(2)}</text></g>)}
        {(['yes','no'] as const).map(side=><g key={side} className={'price-'+side}>{points.map((p,i)=>{
          const q=quote(p,side),prior=points[i-1],previous=prior&&quote(prior,side);
          return q===null?null:<g key={p.timestamp}>{previous!=null&&<line x1={x(prior.timestamp)} y1={y(previous)} x2={x(p.timestamp)} y2={y(q)} stroke="currentColor" strokeWidth="2" strokeDasharray={p.timestamp-prior.timestamp>600?'2 6':undefined}/>}
            <circle cx={x(p.timestamp)} cy={y(q)} r={i===points.length-1?4.5:3} className={i===points.length-1?'price-latest':undefined} fill="currentColor"><title>{side==='yes'?'Yes':'No'}: {(Number(q)/1e6).toFixed(6)} AUSD · {stamp(p.timestamp)}</title></circle></g>;
        })}</g>)}
        <text x="55" y="260">{axisStamp(start)}</text>{end!==start&&<text x="605" y="260" textAnchor="end">{axisStamp(end)}</text>}
      </svg>
      <p className="market-caption">{stamp(start)}{end!==start?` to ${stamp(end)}`:''}</p>
      {gaps.length>0&&<p className="market-caption">Shaded, dotted spans have no recorded samples. Price movement within them is unknown.</p>}
      {points.length===1&&<p className="market-caption">First observation recorded. A trend needs more samples.</p>}
      <details><summary>View exact observations ({points.length})</summary><div className="price-table"><table><caption>One-share buy quotes, sampled from pool state</caption><thead><tr><th>Observed</th><th>Yes (AUSD)</th><th>No (AUSD)</th></tr></thead><tbody>{[...points].reverse().map(p=><tr key={p.timestamp}><td>{stamp(p.timestamp)}</td>{(['yes','no'] as const).map(side=><td key={side}>{quote(p,side)===null?'Unavailable':(Number(quote(p,side))/1e6).toFixed(6)}</td>)}</tr>)}</tbody></table></div></details>
    </>}
    <details><summary>About this chart</summary><p className="market-caption">One-share buy quotes, including trade-size impact. These are not probabilities. Samples are recorded when pages are viewed, at most once per five-minute bucket; up to 288 samples from the last 30 days. Dotted connectors bridge missing observations, not a known price path. This is not a complete trading history.</p></details>
  </section>;
}
