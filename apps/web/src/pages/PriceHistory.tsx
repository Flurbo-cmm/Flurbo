import {useCallback,useEffect,useId,useRef,useState} from 'react';
import {appFetch} from '../platform-fetch';

type Point={timestamp:number;blockNumber:string;prices:{event:number;yes:string|null;no:string|null}[]};
type History={pool:string;sampling:string;points:Point[]};
const stamp=(n:number)=>new Date(n*1000).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
const axisStamp=(n:number)=>new Date(n*1000).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
const TOP=20,BOTTOM=206,HEIGHT=240,LEFT=44;
const square=(cx:number,cy:number,size:number)=>`M${cx-size/2} ${cy-size/2}h${size}v${size}h${-size}Z`;
export default function PriceHistory({oracleId,hybridId,event,pool,refresh}:{event:number;pool:string;refresh:number}&({oracleId:string;hybridId?:never}|{oracleId?:never;hybridId:string})){
  const [data,setData]=useState<History|null>(null),[error,setError]=useState(false);
  const [range,setRange]=useState<'day'|'all'>('all');
  // The chart draws in real pixels of its column, so labels stay legible from phones to wide screens.
  const [width,setWidth]=useState(660),observer=useRef<ResizeObserver|null>(null),tone=`tone${useId().replace(/[^\w-]/g,'')}`;
  const frame=useCallback((node:HTMLDivElement|null)=>{
    observer.current?.disconnect();observer.current=null;
    if(!node||typeof ResizeObserver==='undefined')return;
    observer.current=new ResizeObserver(([entry])=>setWidth(Math.max(280,Math.round(entry.contentRect.width))));observer.current.observe(node);
  },[]);
  useEffect(()=>()=>observer.current?.disconnect(),[]);
  useEffect(()=>{const abort=new AbortController();setError(false);
    const load=appFetch(`/api/${oracleId?'oracle':'hybrid'}/${oracleId||hybridId}/price-history`,{credentials:'same-origin',signal:abort.signal}).then(async response=>{
      if(!response.ok)throw Error('Price history unavailable');
      return response.json() as Promise<History>;
    });
    void load.then(value=>{
      if(value.pool!==pool)throw Error('Different collection');
      if(!abort.signal.aborted)setData(value);
    }).catch(()=>{if(!abort.signal.aborted)setError(true);});return()=>abort.abort();
  },[oracleId,hybridId,pool,event,refresh]);
  const points=(data?.points||[]).filter(p=>range==='all'||p.timestamp>=Date.now()/1000-86400);
  const start=points[0]?.timestamp||0,end=points.at(-1)?.timestamp||start;
  const ceiling=Math.max(1,...points.flatMap(p=>{const q=p.prices.find(q=>q.event===event);return [Number(q?.yes||0)/1e6,Number(q?.no||0)/1e6];}));
  const right=width-52;
  const x=(time:number)=>points.length===1?(LEFT+right)/2:LEFT+(time-start)/Math.max(1,end-start)*(right-LEFT);
  const y=(atoms:string)=>BOTTOM-Number(atoms)/1e6/ceiling*(BOTTOM-TOP);
  const quote=(p:Point,side:'yes'|'no')=>p.prices.find(q=>q.event===event)?.[side]??null;
  const gaps=points.flatMap((p,i)=>i&&p.timestamp-points[i-1].timestamp>600?[{from:points[i-1].timestamp,to:p.timestamp}]:[]);
  // Runs of consecutive Yes samples, each shaded down to the baseline with a printed dot tone.
  const runs=points.reduce<Point[][]>((all,p)=>{if(quote(p,'yes')===null)all.push([]);else all.at(-1)!.push(p);return all;},[[]]).filter(run=>run.length>1);
  const area=(run:Point[])=>`M${x(run[0].timestamp)} ${BOTTOM}${run.map(p=>` L${x(p.timestamp)} ${y(quote(p,'yes')!)}`).join('')} L${x(run.at(-1)!.timestamp)} ${BOTTOM}Z`;
  const latest=points.at(-1),ends=(['yes','no'] as const).flatMap(side=>{const q=latest&&quote(latest,side);return q==null?[]:[{side,q,at:y(q)}];});
  if(ends.length===2&&Math.abs(ends[0].at-ends[1].at)<14){const mid=(ends[0].at+ends[1].at)/2,up=ends[0].at<=ends[1].at?-7:7;ends[0].at=mid+up;ends[1].at=mid-up;}
  const marks=points.length<=40;
  return <section className="detail-panel price-history" aria-label="Price history">
    <div className="detail-section-heading"><h2>Price history</h2><div className="price-ranges" role="group" aria-label="Chart time range">{(['day','all'] as const).map(v=><button key={v} type="button" aria-pressed={range===v} onClick={()=>setRange(v)}>{v==='day'?'24 hours':'All samples'}</button>)}</div></div>
    <p className="market-caption">Cost of one share in test AUSD. Not a probability.</p>
    {error?<p role="status" className="state-inline">Price history could not be refreshed. {data?'Showing previously loaded samples.':'Your trading balance is unaffected.'}</p>:!data?<><span className="skeleton" style={{height:220}} aria-hidden="true"/><p role="status" className="sr-only">Loading recorded prices…</p></>:null}
    {data?.sampling==='unavailable'&&!error&&<p role="status">The latest price sample is unavailable. Earlier observations remain below.</p>}
    {data?.sampling==='closed'&&<p className="market-caption">Trading has closed. Showing recorded prices before close.</p>}
    {data&&!points.length?<p>No recorded prices for this range yet. Samples begin when this market is viewed.</p>:points.length>0&&<>
      <div className="price-legend" aria-hidden="true"><span className="price-yes">Yes, solid</span><span className="price-no">No, dashed</span></div>
      <div className="price-chart" ref={frame}><svg viewBox={`0 0 ${width} ${HEIGHT}`} width={width} height={HEIGHT} role="img" aria-label="Sampled Yes and No one-share buy prices over time. Exact observations are in the table below.">
        <defs><pattern id={tone} width="5" height="5" patternUnits="userSpaceOnUse"><path d="M0 0h1.5v1.5H0Z" className="price-tone-dot"/></pattern></defs>
        {gaps.map(g=><rect key={g.from} x={x(g.from)} y={TOP} width={x(g.to)-x(g.from)} height={BOTTOM-TOP} className="price-gap"><title>No observations recorded during this interval</title></rect>)}
        {[0,.5,1].map(f=><g key={f} className={f?"price-grid":"price-grid price-base"}><line x1={LEFT} x2={right} y1={BOTTOM-f*(BOTTOM-TOP)} y2={BOTTOM-f*(BOTTOM-TOP)}/><text x={LEFT-10} y={BOTTOM-f*(BOTTOM-TOP)+4} textAnchor="end">{(ceiling*f).toFixed(2)}</text></g>)}
        {runs.map(run=><path key={run[0].timestamp} d={area(run)} fill={`url(#${tone})`} className="price-tone"/>)}
        {(['yes','no'] as const).map(side=><g key={side} className={'price-'+side}>{points.map((p,i)=>{
          const q=quote(p,side),prior=points[i-1],previous=prior&&quote(prior,side),last=i===points.length-1;
          return q===null?null:<g key={p.timestamp}>{previous!=null&&<line x1={x(prior.timestamp)} y1={y(previous)} x2={x(p.timestamp)} y2={y(q)} stroke="currentColor" strokeDasharray={p.timestamp-prior.timestamp>600?'2 6':undefined}/>}
            {(marks||last)&&<path d={square(x(p.timestamp),y(q),last?9:4)} className={last?'price-latest':'price-mark'}/>}
            <circle cx={x(p.timestamp)} cy={y(q)} r="7" className="price-hit"><title>{side==='yes'?'Yes':'No'}: {(Number(q)/1e6).toFixed(6)} AUSD · {stamp(p.timestamp)}</title></circle></g>;
        })}</g>)}
        {ends.map(e=><text key={e.side} x={right+12} y={e.at+4} className={'price-end price-end-'+e.side}>{(Number(e.q)/1e6).toFixed(3)}</text>)}
        <text x={LEFT} y={HEIGHT-6}>{axisStamp(start)}</text>{end!==start&&<text x={right} y={HEIGHT-6} textAnchor="end">{axisStamp(end)}</text>}
      </svg></div>
      <p className="market-caption">{stamp(start)}{end!==start?` to ${stamp(end)}`:''}</p>
      {gaps.length>0&&<p className="market-caption">Shaded, dotted spans have no recorded samples. Price movement within them is unknown.</p>}
      {points.length===1&&<p className="market-caption">First observation recorded. A trend needs more samples.</p>}
      <details><summary>View exact observations ({points.length})</summary><div className="price-table"><table><caption>One-share buy quotes, sampled from pool state</caption><thead><tr><th>Observed</th><th>Yes (AUSD)</th><th>No (AUSD)</th></tr></thead><tbody>{[...points].reverse().map(p=><tr key={p.timestamp}><td>{stamp(p.timestamp)}</td>{(['yes','no'] as const).map(side=><td key={side}>{quote(p,side)===null?'Unavailable':(Number(quote(p,side))/1e6).toFixed(6)}</td>)}</tr>)}</tbody></table></div></details>
    </>}
    <details><summary>About this chart</summary><p className="market-caption">One-share buy quotes, including trade-size impact. These are not probabilities. Samples are recorded when pages are viewed, at most once per five-minute bucket; up to 288 samples from the last 30 days. Dotted connectors bridge missing observations, not a known price path. This is not a complete trading history.</p></details>
  </section>;
}
