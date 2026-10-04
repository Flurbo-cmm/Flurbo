import {useEffect,useMemo,useState} from 'react';
import {Link,useLocation} from 'wouter';
import {Search,ArrowUpRight,RefreshCw,Inbox} from 'lucide-react';
import {formatUnits} from 'viem';
import {useAuth} from '../auth/context';
import {appFetch} from '../platform-fetch';
import {pilotRequest,type PilotNamespace} from '../pilot';
import {loadMarketDirectory,marketStatus,type MarketGroup,type MarketSnapshot,type OracleMarket,type OracleMarketSummary,type HybridMarket,type HybridMarketSummary,type MarketDirectory as MarketDirectoryData} from '../market-directory';
import {marketHref} from '../market-detail';
import {marketQuestion} from '../showcase-copy';
import MarketDetail from './MarketDetail';
import OracleMarketDetail from './OracleMarkets';
import HybridMarketDetail from './HybridMarket';
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
  const [directory,setDirectory]=useState<MarketDirectoryData|null>(null),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
  useEffect(()=>{const c=new AbortController();setError('');void loadMarketDirectory(c.signal).then(setDirectory).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[attempt]);
  const gate=useLoadGate('directory',{pending:!directory&&!error,label:'Loading markets'});
  if(!directory)return <main id="main" tabIndex={-1} className="page markets-page" aria-busy={!error}>
    <PageHeader title={location==='/portfolio'?<>Your portfolio.</>:'What happens next?'} lead={location==='/portfolio'?'All your linked wallet positions. Results and payouts in one place.':'Choose a question. Take a view. Explore how it connects.'}/>
    {error?<div className="state-block" role="alert"><h2>Markets could not load</h2><p>{error}</p><button className="btn btn-primary" onClick={()=>setAttempt(x=>x+1)}>Retry</button></div>
      :<>{!gate.covered&&<span className="progress-line" aria-hidden="true"/>}<p role="status" className={gate.covered?'sr-only':'busy-text'}>Loading markets...</p><MarketSkeleton/></>}
  </main>;
  const {groups,oracleMarkets,hybridMarkets}=directory;
  const hybridId=location.match(/^\/markets\/hybrid\/(0x[0-9a-f]{40})\/([0-9]|[12][0-9]|3[01])$/i);
  if(hybridId){const id=`${hybridId[1]}-${Number(hybridId[2])}`;return hybridMarkets.some(m=>m.id.toLowerCase()===id.toLowerCase())
    ?<HybridMarketDetail key={id} id={hybridMarkets.find(m=>m.id.toLowerCase()===id.toLowerCase())!.id} markets={hybridMarkets}/>
    :<main id="main" tabIndex={-1} className="page page-task"><div className="state-block"><Inbox aria-hidden="true" strokeWidth={1.75}/><h1>Market not found</h1><Link href="/markets" className="btn btn-primary">All markets</Link></div></main>;}
  const oracleId=location.match(/^\/markets\/oracle\/([a-z0-9-]{1,64})$/)?.[1];
  if(oracleId)return oracleMarkets.some(m=>m.id===oracleId)
    ?<OracleMarketDetail key={oracleId} id={oracleId} markets={oracleMarkets}/>
    :<main id="main" tabIndex={-1} className="page page-task"><div className="state-block"><Inbox aria-hidden="true" strokeWidth={1.75}/><h1>Market not found</h1><Link href="/markets" className="btn btn-primary">All markets</Link></div></main>;
  const detail=location.match(/^\/markets\/(pilot|practice-[0-9a-f]{40})\/([0-3])(\/thesis)?$/);
  if(location.startsWith('/markets/')){
    if(!detail||!groups.some(g=>g.namespace===detail[1]))return <main id="main" tabIndex={-1} className="page page-task"><div className="state-block"><Inbox aria-hidden="true" strokeWidth={1.75}/><h1>Market not found</h1><p>This market is not in the current directory. It may belong to an earlier collection that is no longer listed.</p><Link href="/markets" className="btn btn-primary">All markets</Link></div></main>;
    return detail[3]?<ThesisExplorer key={location} namespace={detail[1] as PilotNamespace} event={Number(detail[2])}/>:<MarketDetail key={location} namespace={detail[1] as PilotNamespace} event={Number(detail[2])}/>;
  }
  if(location==='/portfolio')return <main id="main" tabIndex={-1} className="page markets-page portfolio-page">
    <PageHeader title="Your portfolio." lead="All your linked wallet positions. Results and payouts in one place."/>
    {auth.address&&<AccountPortfolio account={auth.address} namespace="all" groups={groups}/>}
  </main>;
  return <MarketDirectory groups={groups} oracleMarkets={oracleMarkets} hybridMarkets={hybridMarkets}/>;
}

function MarketSkeleton({rows=5}:{rows?:number}){
  return <div className="market-list market-list-skeleton" aria-hidden="true">{Array.from({length:rows},(_,i)=><div className="market-row-skeleton" key={i}><span className="skeleton skeleton-line" style={{width:`${62-(i%3)*9}%`}}/><span className="skeleton skeleton-line" style={{width:'18%'}}/><span className="skeleton" style={{height:36}}/><span className="skeleton" style={{height:36}}/></div>)}</div>;
}

type Row={key:string;groupKey:string;groupLabel:string;category:string;question:string;closesAt:number;status:string;prices:{yes:string|null;no:string|null}|null;priceAt:number|null;href:(yes?:boolean)=>string;combinable:boolean;payoutNote:string};
const statusKind=(status:string,closesAt:number,now:number):[StatusKind,string]=>status==='Open'?(closesAt-now<CLOSING_SOON_SECONDS?['closing','Closing soon']:['open','Open']):status==='Closed'?['closed','Closed']:status==='Settled'?['settled','Settled']:['unavailable','Unavailable'];
const category=(value:MarketSnapshot)=>value.manifest.publication.mode==='rehearsal'?'Practice':value.manifest.publication.mode==='ethereum-activity'?'Ethereum':'Ecosystem';

function MarketDirectory({groups,oracleMarkets,hybridMarkets}:{groups:MarketGroup[];oracleMarkets:OracleMarket[];hybridMarkets:HybridMarket[]}){
  const [data,setData]=useState<Record<string,MarketSnapshot>>({}),[oracleData,setOracleData]=useState<Record<string,OracleMarketSummary>>({}),[hybridData,setHybridData]=useState<Record<string,HybridMarketSummary>>({}),[failed,setFailed]=useState<string[]>([]),[loading,setLoading]=useState(true),[revision,setRevision]=useState(0);
  const [query,setQuery]=useState(''),[filter,setFilter]=useState('Open'),[sort,setSort]=useState('closing'),[now,setNow]=useState(Date.now());
  const [firstAt,setFirstAt]=useState<number|null>(null),[updatedAt,setUpdatedAt]=useState<number|null>(null);
  useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(t);},[]);
  useEffect(()=>{const timer=setInterval(()=>{if(!document.hidden&&!loading)setRevision(n=>n+1);},45000);return()=>clearInterval(timer);},[loading]);
  useEffect(()=>{
    const c=new AbortController(),queue:[string,MarketGroup|OracleMarket|HybridMarket][]= [...groups.map(g=>['pilot',g] as [string,MarketGroup]),...oracleMarkets.map(m=>['oracle',m] as [string,OracleMarket]),...hybridMarkets.map(m=>['hybrid',m] as [string,HybridMarket])];setLoading(true);setFailed([]);
    // Two pools at a time. One unavailable pool never hides the others.
    void Promise.all(Array.from({length:Math.min(2,queue.length)},async()=>{
      while(queue.length&&!c.signal.aborted){const [kind,item]=queue.shift()!,key=kind==='oracle'?`oracle:${(item as OracleMarket).id}`:kind==='hybrid'?`hybrid:${(item as HybridMarket).id}`:(item as MarketGroup).namespace;
        try{
          if(kind==='oracle'){
            const market=item as OracleMarket;
            const response=await appFetch(`/api/oracle/${market.id}/market`,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.any([c.signal,AbortSignal.timeout(20000)])});
            if(!response.ok)throw Error('Oracle quote unavailable');
            const value=await response.json() as OracleMarketSummary;
            if(value.schema!=='flurbo.oracle-market.v1'||value.id!==market.id||typeof value.pool!=='string'||value.pool.toLowerCase()!==market.pool.toLowerCase()||!Number.isSafeInteger(value.marketNow)||typeof value.funded!=='boolean'||typeof value.resolved!=='boolean'||!value.prices||[value.prices.yes,value.prices.no].some(p=>p!==null&&(typeof p!=='string'||!/^\d+$/.test(p))))throw Error('Wrong oracle market');
            if(!c.signal.aborted){setOracleData(old=>({...old,[market.id]:value}));setFirstAt(old=>old??Date.now());}
          }else if(kind==='hybrid'){
            const market=item as HybridMarket;
            const response=await appFetch(`/api/hybrid/${market.id}/market`,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.any([c.signal,AbortSignal.timeout(20000)])});
            if(!response.ok)throw Error('Market quote unavailable');
            const value=await response.json() as HybridMarketSummary;
            if(value.schema!=='flurbo.hybrid-market.v1'||value.id.toLowerCase()!==market.id.toLowerCase()||value.pool.toLowerCase()!==market.pool.toLowerCase()||!Number.isSafeInteger(value.marketNow)||typeof value.funded!=='boolean'||typeof value.resolved!=='boolean'||!value.prices||[value.prices.yes,value.prices.no].some(p=>p!==null&&(typeof p!=='string'||!/^\d+$/.test(p))))throw Error('Wrong market');
            if(!c.signal.aborted){setHybridData(old=>({...old,[market.id]:value}));setFirstAt(old=>old??Date.now());}
          }else{
            const group=item as MarketGroup,value=await pilotRequest<MarketSnapshot>('markets',undefined,group.namespace,c.signal);
            if(value.manifest.pool!==group.pool)throw Error('Wrong market');
            if(!c.signal.aborted){setData(old=>({...old,[group.namespace]:value}));setFirstAt(old=>old??Date.now());}
          }
        }catch{if(!c.signal.aborted){if(kind==='oracle'){const id=(item as OracleMarket).id;setOracleData(old=>{const next={...old};delete next[id];return next;});}else if(kind==='hybrid'){const id=(item as HybridMarket).id;setHybridData(old=>{const next={...old};delete next[id];return next;});}else{const namespace=(item as MarketGroup).namespace;setData(old=>{const next={...old};delete next[namespace];return next;});}setFailed(old=>[...old,key]);}}
      }
    })).finally(()=>{if(!c.signal.aborted){setLoading(false);setUpdatedAt(Date.now());}});return()=>c.abort();
  },[groups,oracleMarkets,hybridMarkets,revision]);
  // The first visit waits under the loader until pools settle (or three seconds after the first
  // arrives), so late pools do not reorder a list the visitor has started reading.
  useLoadGate('directory-prices',{pending:loading&&!(firstAt!==null&&now-firstAt>3000),label:'Loading prices'});
  const eventCount=useMemo(()=>Object.fromEntries(Object.entries(data).map(([ns,v])=>[ns,v.manifest.publication.draft.events.length])),[data]);
  const oracleCount=useMemo(()=>oracleMarkets.reduce<Record<string,number>>((counts,m)=>{const key=m.pool.toLowerCase();counts[key]=(counts[key]||0)+1;return counts;},{}),[oracleMarkets]);
  const hybridCount=useMemo(()=>hybridMarkets.reduce<Record<string,number>>((counts,m)=>{const key=m.pool.toLowerCase();counts[key]=(counts[key]||0)+1;return counts;},{}),[hybridMarkets]);
  const all:Row[]=[
    ...groups.flatMap(group=>data[group.namespace]?data[group.namespace].manifest.publication.draft.events.map((event,index)=>{
      const value=data[group.namespace],quote=value.prices.find(p=>p.event===index);
      return {key:group.namespace+event.id,groupKey:group.namespace,groupLabel:group.label,category:category(value),question:marketQuestion(event),closesAt:group.closesAt,status:marketStatus(value,now/1000),prices:quote?{yes:quote.yes,no:quote.no}:null,priceAt:value.snapshot.timestamp,href:(yes?:boolean)=>marketHref(group.namespace,index,yes),combinable:(eventCount[group.namespace]||0)>1,payoutNote:'Results available. Collect eligible payouts in Portfolio.'};
    }):[]),
    ...oracleMarkets.map(m=>{const value=oracleData[m.id],closed=now/1000>=m.closesAt;
      return {key:`oracle:${m.id}`,groupKey:`oracle:${m.pool.toLowerCase()}`,groupLabel:m.poolTitle,category:'Reality.eth + Kleros',question:m.question,closesAt:m.closesAt,status:value?.resolved?'Settled':closed?'Closed':value?.funded===false?'Unavailable':'Open',prices:value?.prices??null,priceAt:value?.marketNow??null,href:(yes?:boolean)=>`/markets/oracle/${m.id}${yes===undefined?'':`?answer=${yes?'yes':'no'}`}`,combinable:oracleCount[m.pool.toLowerCase()]>1,payoutNote:'Results available. Open this market to collect eligible payouts.'};
    }),
    ...hybridMarkets.map(m=>{const value=hybridData[m.id],closed=now/1000>=m.closesAt;
      return {key:`hybrid:${m.id}`,groupKey:`hybrid:${m.pool.toLowerCase()}`,groupLabel:m.poolTitle,category:m.route==='mechanical'?'Source verified · Kleros challenge':'Reality.eth + Kleros',question:m.question,closesAt:m.closesAt,status:value?.resolved?'Settled':closed?'Closed':value?.funded===false?'Unavailable':'Open',prices:value?.prices??null,priceAt:value?.marketNow??null,href:(yes?:boolean)=>`/markets/hybrid/${m.pool}/${m.eventIndex}${yes===undefined?'':`?answer=${yes?'yes':'no'}`}`,combinable:hybridCount[m.pool.toLowerCase()]>1,payoutNote:'Results available. Open this market to collect eligible payouts.'};
    }),
  ];
  const rows=all.filter(r=>(filter==='All'||r.status===filter)&&r.question.toLowerCase().includes(query.toLowerCase())).sort((a,b)=>{
    const rank=(status:string)=>status==='Open'?0:status==='Closed'?1:2;
    const difference=rank(a.status)-rank(b.status);if(difference)return difference;
    return sort==='name'?a.question.localeCompare(b.question):a.closesAt-b.closesAt;
  });
  const pendingPools=loading?groups.filter(g=>!data[g.namespace]&&!failed.includes(g.namespace)).length+oracleMarkets.filter(m=>!oracleData[m.id]&&!failed.includes(`oracle:${m.id}`)).length+hybridMarkets.filter(m=>!hybridData[m.id]&&!failed.includes(`hybrid:${m.id}`)).length:0;
  const grouped=sort==='closing';
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
        const showGroup=grouped&&(i===0||rows[i-1].groupKey!==row.groupKey);
        const fresh=row.priceAt!==null&&now/1000-row.priceAt<60;
        const [kind,label]=statusKind(row.status,row.closesAt,now/1000);
        const price=(atoms:string|null|undefined)=>atoms!=null&&fresh?Number(formatUnits(BigInt(atoms),6)).toFixed(3):null;
        return <div className="market-row-wrap" key={row.key}>
          {showGroup&&<div className="market-group-head"><strong>{row.groupLabel}</strong><span>{row.category}</span>{row.combinable&&<span>Questions in this pool can be combined on any of its market pages</span>}</div>}
          <article className="market-card">
            <div className="market-question"><h2><Link href={row.href()}>{row.question}</Link></h2>{!grouped&&<p className="directory-context">{row.groupLabel}</p>}</div>
            <div className="market-status"><StatusBadge kind={kind}>{label}</StatusBadge></div>
            <p className="directory-deadline"><span className="sr-only">{row.status==='Open'?'Closes':'Trading closed'} </span><time dateTime={new Date(row.closesAt*1000).toISOString()} title={exactTime(row.closesAt)}>{relativeTime(row.closesAt,now/1000)}</time><small>{shortTime(row.closesAt)}</small></p>
            {row.status==='Open'?<div className="market-choices">{[true,false].map(yes=><Link key={String(yes)} aria-label={(yes?'Yes: ':'No: ')+row.question} href={row.href(yes)} className={yes?'choice-yes':'choice-no'}><span>{yes?'Yes':'No'}</span><strong className="num">{price(yes?row.prices?.yes:row.prices?.no)??'View quote'}</strong></Link>)}</div>
              :<p className="directory-result">{row.status==='Settled'?row.payoutNote:'Trading is unavailable. Open this market for its current resolution status.'}</p>}
          </article>
        </div>;
      })}
    </div>}
    {pendingPools>0&&rows.length>0&&<div className="market-pending"><span className="progress-line" aria-hidden="true"/><span className="busy-text">Loading {pendingPools} more {pendingPools===1?'collection':'collections'}</span></div>}
    {!rows.length&&(loading&&!all.length?<MarketSkeleton/>:<section className="state-block directory-empty"><Inbox aria-hidden="true" strokeWidth={1.75}/><h2>{loading?'Loading questions...':!all.length&&failed.length?'Markets are temporarily unavailable':query?'No matching questions':filter==='Open'?'No open markets right now':'No markets to show'}</h2><p>{loading?'Questions appear as their prices are checked.':query?'Try a different search or show all markets.':filter==='Open'?'You can view closed markets and follow existing positions in Portfolio. New opening dates have not been announced.':'Try another status or search. New questions will appear here when they are published.'}</p><button className="btn btn-secondary" onClick={()=>{setQuery('');setFilter('All');}}>Show all markets</button></section>)}
    <p className="market-foot"><Link href="/docs#combinations" className="text-link">How combined predictions work</Link></p>
  </main>;
}
