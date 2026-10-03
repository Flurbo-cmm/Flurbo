import {useEffect,useMemo,useState} from 'react';
import {Link,useLocation} from 'wouter';
import {Search,ArrowUpRight,RefreshCw,Inbox} from 'lucide-react';
import {formatUnits} from 'viem';
import {useAuth} from '../auth/context';
import {pilotRequest,type PilotNamespace} from '../pilot';
import {loadMarketDirectory,marketStatus,type MarketGroup,type MarketSnapshot} from '../market-directory';
import {marketHref} from '../market-detail';
import {marketQuestion} from '../showcase-copy';
import MarketDetail from './MarketDetail';
import ThesisExplorer from './ThesisExplorer';
import AccountPortfolio from './AccountPortfolio';
import PageHeader from '../components/PageHeader';
import StatusBadge,{type StatusKind} from '../components/ui/StatusBadge';
import {useLoadGate} from '../loading/gates';
import {CLOSING_SOON_SECONDS,exactTime,relativeTime,shortTime} from '../format';
import './workspace.css';
import './markets.css';

export default function Markets(){
  const [location]=useLocation();
  const {state:auth}=useAuth();
  const [groups,setGroups]=useState<MarketGroup[]|null>(null),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
  useEffect(()=>{const c=new AbortController();setError('');void loadMarketDirectory(c.signal).then(setGroups).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[attempt]);
  const gate=useLoadGate('directory',{pending:!groups&&!error,label:'Loading markets'});
  if(!groups)return <main id="main" tabIndex={-1} className="page markets-page" aria-busy={!error}>
    <PageHeader title={location==='/portfolio'?<>Your portfolio.</>:'What happens next?'} lead={location==='/portfolio'?'All your linked wallet positions. Results and payouts in one place.':'Choose a question. Take a view. Explore how it connects.'}/>
    {error?<div className="state-block" role="alert"><h2>Markets could not load</h2><p>{error}</p><button className="btn btn-primary" onClick={()=>setAttempt(x=>x+1)}>Retry</button></div>
      :<>{!gate.covered&&<span className="progress-line" aria-hidden="true"/>}<p role="status" className={gate.covered?'sr-only':'busy-text'}>Loading markets...</p><MarketSkeleton/></>}
  </main>;
  const detail=location.match(/^\/markets\/(pilot|practice-[0-9a-f]{40})\/([0-3])(\/thesis)?$/);
  if(location.startsWith('/markets/')){
    if(!detail||!groups.some(g=>g.namespace===detail[1]))return <main id="main" tabIndex={-1} className="page page-task"><div className="state-block"><Inbox aria-hidden="true" strokeWidth={1.75}/><h1>Market not found</h1><p>This market is not in the current directory. It may belong to an earlier collection that is no longer listed.</p><Link href="/markets" className="btn btn-primary">All markets</Link></div></main>;
    return detail[3]?<ThesisExplorer key={location} namespace={detail[1] as PilotNamespace} event={Number(detail[2])}/>:<MarketDetail key={location} namespace={detail[1] as PilotNamespace} event={Number(detail[2])}/>;
  }
  if(location==='/portfolio')return <main id="main" tabIndex={-1} className="page markets-page portfolio-page">
    <PageHeader title="Your portfolio." lead="All your linked wallet positions. Results and payouts in one place."/>
    {auth.address&&<AccountPortfolio account={auth.address} namespace="all" groups={groups}/>}
  </main>;
  return <MarketDirectory groups={groups}/>;
}

function MarketSkeleton({rows=5}:{rows?:number}){
  return <div className="market-list market-list-skeleton" aria-hidden="true">{Array.from({length:rows},(_,i)=><div className="market-row-skeleton" key={i}><span className="skeleton skeleton-line" style={{width:`${62-(i%3)*9}%`}}/><span className="skeleton skeleton-line" style={{width:'18%'}}/><span className="skeleton" style={{height:36}}/><span className="skeleton" style={{height:36}}/></div>)}</div>;
}

type Row={group:MarketGroup;event:MarketSnapshot['manifest']['publication']['draft']['events'][number];index:number;value:MarketSnapshot};
const statusKind=(status:string,closesAt:number,now:number):[StatusKind,string]=>status==='Open'?(closesAt-now<CLOSING_SOON_SECONDS?['closing','Closing soon']:['open','Open']):status==='Closed'?['closed','Closed']:status==='Settled'?['settled','Settled']:['unavailable','Unavailable'];
const category=(value:MarketSnapshot)=>value.manifest.publication.mode==='rehearsal'?'Practice':value.manifest.publication.mode==='ethereum-activity'?'Ethereum':'Ecosystem';

function MarketDirectory({groups}:{groups:MarketGroup[]}){
  const [data,setData]=useState<Record<string,MarketSnapshot>>({}),[failed,setFailed]=useState<string[]>([]),[loading,setLoading]=useState(true),[revision,setRevision]=useState(0);
  const [query,setQuery]=useState(''),[filter,setFilter]=useState('Open'),[sort,setSort]=useState('closing'),[now,setNow]=useState(Date.now());
  const [firstAt,setFirstAt]=useState<number|null>(null),[updatedAt,setUpdatedAt]=useState<number|null>(null);
  useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(t);},[]);
  useEffect(()=>{const timer=setInterval(()=>{if(!document.hidden&&!loading)setRevision(n=>n+1);},45000);return()=>clearInterval(timer);},[loading]);
  useEffect(()=>{
    const c=new AbortController(),queue=[...groups];setLoading(true);setFailed([]);
    // Two pools at a time. One unavailable pool never hides the others.
    void Promise.all(Array.from({length:Math.min(2,queue.length)},async()=>{
      while(queue.length&&!c.signal.aborted){const group=queue.shift()!;
        try{const value=await pilotRequest<MarketSnapshot>('markets',undefined,group.namespace,c.signal);if(value.manifest.pool!==group.pool)throw Error('Wrong market');if(!c.signal.aborted){setData(old=>({...old,[group.namespace]:value}));setFirstAt(old=>old??Date.now());}}
        catch{if(!c.signal.aborted){setData(old=>{const next={...old};delete next[group.namespace];return next;});setFailed(old=>[...old,group.namespace]);}}
      }
    })).finally(()=>{if(!c.signal.aborted){setLoading(false);setUpdatedAt(Date.now());}});return()=>c.abort();
  },[groups,revision]);
  // The first visit waits under the loader until pools settle (or three seconds after the first
  // arrives), so late pools do not reorder a list the visitor has started reading.
  useLoadGate('directory-prices',{pending:loading&&!(firstAt!==null&&now-firstAt>3000),label:'Loading prices'});
  const all:Row[]=groups.flatMap(group=>data[group.namespace]?data[group.namespace].manifest.publication.draft.events.map((event,index)=>({group,event,index,value:data[group.namespace]})):[]);
  const rows=all.filter(r=>(filter==='All'||marketStatus(r.value,now/1000)===filter)&&marketQuestion(r.event).toLowerCase().includes(query.toLowerCase())).sort((a,b)=>{
    const rank=(v:MarketSnapshot)=>marketStatus(v,now/1000)==='Open'?0:marketStatus(v,now/1000)==='Closed'?1:2;
    const difference=rank(a.value)-rank(b.value);if(difference)return difference;
    return sort==='name'?marketQuestion(a.event).localeCompare(marketQuestion(b.event)):a.group.closesAt-b.group.closesAt;
  });
  const pendingPools=loading?groups.filter(g=>!data[g.namespace]&&!failed.includes(g.namespace)).length:0;
  const grouped=sort==='closing';
  const eventCount=useMemo(()=>Object.fromEntries(Object.entries(data).map(([ns,v])=>[ns,v.manifest.publication.draft.events.length])),[data]);
  return <main id="main" tabIndex={-1} className="page markets-page">
    <PageHeader title="What happens next?" lead="Choose a question. Take a view. Explore how it connects." actions={<Link href="/fund" className="text-link">Get test funds <ArrowUpRight strokeWidth={1.75}/></Link>}/>
    <div className="market-toolbar" role="search">
      <label className="market-search"><Search aria-hidden="true" strokeWidth={1.75}/><span className="sr-only">Search markets</span><input placeholder="Find a market" value={query} onChange={e=>setQuery(e.target.value)}/></label>
      <div className="segmented directory-filters" role="group" aria-label="Market status">{['All','Open','Closed','Settled'].map(f=><button key={f} type="button" aria-pressed={f===filter} onClick={()=>setFilter(f)}>{f}</button>)}</div>
      <div className="segmented directory-sort" role="group" aria-label="Sort">{([['closing','Closing soon'],['name','Question name']] as const).map(([value,label])=><button key={value} type="button" aria-pressed={sort===value} onClick={()=>setSort(value)}>{label}</button>)}</div>
    </div>
    <div className="directory-summary">
      <span className="num">{rows.length} of {all.length} questions{loading?' loaded so far':''}</span>
      <span className="freshness">{loading?<span role="status">Updating prices</span>:updatedAt?<span>Prices updated {relativeTime(Math.min(updatedAt,now)/1000,now/1000)}</span>:null}
        <button className="btn btn-secondary btn-sm" disabled={loading} onClick={()=>setRevision(x=>x+1)}><RefreshCw aria-hidden="true" strokeWidth={1.75}/>{loading?'Updating prices...':'Refresh prices'}</button></span>
    </div>
    <p className="market-quote-note">Yes and No show the cost to buy one share, in test AUSD, including price impact. They are not probabilities. A winning share pays 1 test AUSD.</p>
    {failed.length>0&&<p role="alert" className="state-inline error market-error">Some markets could not be refreshed. Other markets are still available. Use Refresh prices to retry.</p>}
    {rows.length>0&&<div className="market-list">
      <div className="market-list-head" aria-hidden="true"><span>Question</span><span>Status</span><span>Closes</span><span className="num">Buy Yes</span><span className="num">Buy No</span></div>
      {rows.map((row,i)=>{
        const {group,event,index,value}=row;
        const showGroup=grouped&&(i===0||rows[i-1].group.namespace!==group.namespace);
        const status=marketStatus(value,now/1000),quotes=value.prices.find(p=>p.event===index),fresh=now/1000-value.snapshot.timestamp<60;
        const [kind,label]=statusKind(status,group.closesAt,now/1000);
        const price=(atoms:string|null|undefined)=>atoms!=null&&fresh?Number(formatUnits(BigInt(atoms),6)).toFixed(3):null;
        const combinable=(eventCount[group.namespace]||0)>1;
        return <div className="market-row-wrap" key={group.namespace+event.id}>
          {showGroup&&<div className="market-group-head"><strong>{group.label}</strong><span>{category(value)}</span>{combinable&&<span>Questions in this pool can be combined on any of its market pages</span>}</div>}
          <article className="market-card">
            <div className="market-question"><h2><Link href={marketHref(group.namespace,index)}>{marketQuestion(event)}</Link></h2>{!grouped&&<p className="directory-context">{group.label}</p>}</div>
            <div className="market-status"><StatusBadge kind={kind}>{label}</StatusBadge></div>
            <p className="directory-deadline"><span className="sr-only">{status==='Open'?'Closes':'Trading closed'} </span><time dateTime={new Date(group.closesAt*1000).toISOString()} title={exactTime(group.closesAt)}>{relativeTime(group.closesAt,now/1000)}</time><small>{shortTime(group.closesAt)}</small></p>
            {status==='Open'?<div className="market-choices">{[true,false].map(yes=><Link key={String(yes)} aria-label={(yes?'Yes: ':'No: ')+marketQuestion(event)} href={marketHref(group.namespace,index,yes)} className={yes?'choice-yes':'choice-no'}><span>{yes?'Yes':'No'}</span><strong className="num">{price(yes?quotes?.yes:quotes?.no)??'View quote'}</strong></Link>)}</div>
              :<p className="directory-result">{status==='Settled'?'Results available. Collect eligible payouts in Portfolio.':'Trading is unavailable. Open this market for its current resolution status.'}</p>}
          </article>
        </div>;
      })}
    </div>}
    {pendingPools>0&&rows.length>0&&<div className="market-pending"><span className="progress-line" aria-hidden="true"/><span className="busy-text">Loading {pendingPools} more {pendingPools===1?'collection':'collections'}</span></div>}
    {!rows.length&&(loading&&!all.length?<MarketSkeleton/>:<section className="state-block directory-empty"><Inbox aria-hidden="true" strokeWidth={1.75}/><h2>{loading?'Loading questions...':!all.length&&failed.length?'Markets are temporarily unavailable':query?'No matching questions':filter==='Open'?'No open markets right now':'No markets to show'}</h2><p>{loading?'Questions appear as their prices are checked.':query?'Try a different search or show all markets.':filter==='Open'?'You can view closed markets and follow existing positions in Portfolio. New opening dates have not been announced.':'Try another status or search. New questions will appear here when they are published.'}</p><button className="btn btn-secondary" onClick={()=>{setQuery('');setFilter('All');}}>Show all markets</button></section>)}
    <p className="market-foot"><Link href="/docs#combinations" className="text-link">How combined predictions work</Link></p>
  </main>;
}
