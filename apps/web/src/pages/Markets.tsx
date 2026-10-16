import {lazy,Suspense,useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Link,Redirect,useLocation,useSearch} from 'wouter';
import {Inbox} from 'lucide-react';
import {useAuth} from '../auth/context';
import {appFetch} from '../platform-fetch';
import {loadMarketDirectory,type OracleMarket,type OracleMarketSummary,type HybridMarket,type HybridMarketSummary,type MarketDirectory as MarketDirectoryData} from '../market-directory';
import {hybridPortfolioGroups,legacyPracticeRedirect} from '../portfolio-groups';
import AccountPortfolio from './AccountPortfolio';
import PageHeader from '../components/PageHeader';
import MarketBoard from '../components/market/MarketBoard';
import {useLoadGate} from '../loading/gates';
import {buildBoardRows,rowFromSnapshot,toSnapshotRow} from '../market-board-rows';
import {CATEGORY_BY_POOL,readBoardQuery,writeBoardQuery,type BoardQuery,type CategorySlug} from '../market-categories';
import {directoryHash,readBoardSnapshot,writeBoardSnapshot,type BoardSnapshot} from '../board-cache';
import {priceDelta,readSeen,writeSeen,SEEN_MIN_AGE_MS,type SeenPrices} from '../price-memory';
import {readWatchlist,toggleWatchlist} from '../watchlist';
import './workspace.css';
import './markets.css';

export const BOARD_URL_KEY='flurbo.board-url';

// Oracle and hybrid pages load when opened, so the board itself stays light. The board warms them when idle.
const loadOracle=()=>import('./OracleMarkets'),loadHybrid=()=>import('./HybridMarket'),loadHybridThesis=()=>import('./HybridAnalysis');
const OracleMarketDetail=lazy(loadOracle),HybridMarketDetail=lazy(loadHybrid);
const HybridThesis=lazy(()=>loadHybridThesis().then(module=>({default:module.HybridThesis})));
export function warmMarketPages(){for(const load of [loadOracle,loadHybrid,loadHybridThesis])void load().catch(()=>undefined);}
function PagePending(){
  const gate=useLoadGate('market-page',{pending:true,label:'Loading the market'});
  return <main id="main" tabIndex={-1} className="page" aria-busy="true">{!gate.covered&&<span className="progress-line" aria-hidden="true"/>}<p role="status" className={gate.covered?'sr-only':'busy-text'}>Loading the market...</p></main>;
}

export default function Markets(){
  const [location]=useLocation();
  const {state:auth}=useAuth();
  const [directory,setDirectory]=useState<MarketDirectoryData|null>(null),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
  // A returning member sees their last board at once; it refreshes in place when the directory and prices arrive.
  const [snapshot]=useState<BoardSnapshot|null>(()=>location==='/markets'&&auth.address?readBoardSnapshot(auth.address):null);
  const usableSnapshot=location==='/markets'&&!!snapshot?.rows.length;
  useEffect(()=>{const c=new AbortController();setError('');void loadMarketDirectory(c.signal).then(setDirectory).catch(e=>{if(!c.signal.aborted)setError(e.message);});return()=>c.abort();},[attempt]);
  const gate=useLoadGate('directory',{pending:!directory&&!error&&!usableSnapshot,label:'Loading markets'});
  const portfolioGroups=useMemo(()=>directory?hybridPortfolioGroups(directory.hybridMarkets):[],[directory]);
  const legacy=legacyPracticeRedirect(location);
  if(legacy)return <Redirect to={legacy} replace/>;
  if(!directory&&usableSnapshot&&!error)return <MarketDirectory directory={null} snapshot={snapshot}/>;
  if(!directory)return <main id="main" tabIndex={-1} className="page markets-page" aria-busy={!error}>
    <PageHeader title={location==='/portfolio'?<>Your portfolio.</>:'What happens next?'} lead={location==='/portfolio'?'All your linked wallet positions. Results and payouts in one place.':'Choose a question. Take a view. Explore how it connects.'}/>
    {error?<div className="state-block" role="alert"><h2>Markets could not load</h2><p>{error}</p><button className="btn btn-primary" onClick={()=>setAttempt(x=>x+1)}>Retry</button></div>
      :<>{!gate.covered&&<span className="progress-line" aria-hidden="true"/>}<p role="status" className={gate.covered?'sr-only':'busy-text'}>Loading markets...</p><MarketSkeleton/></>}
  </main>;
  const {oracleMarkets,hybridMarkets}=directory;
  const hybridId=location.match(/^\/markets\/hybrid\/(0x[0-9a-f]{40})\/([0-9]|[12][0-9]|3[01])(\/thesis)?$/i);
  if(hybridId){const id=`${hybridId[1]}-${Number(hybridId[2])}`;const market=hybridMarkets.find(m=>m.id.toLowerCase()===id.toLowerCase());return market
    ?<Suspense fallback={<PagePending/>}>{hybridId[3]?<HybridThesis key={location} market={market} markets={hybridMarkets}/>:<HybridMarketDetail key={id} id={market.id} markets={hybridMarkets}/>}</Suspense>
    :<main id="main" tabIndex={-1} className="page page-task"><div className="state-block"><Inbox aria-hidden="true" strokeWidth={1.75}/><h1>Market not found</h1><Link href="/markets" className="btn btn-primary">All markets</Link></div></main>;}
  const oracleId=location.match(/^\/markets\/oracle\/([a-z0-9-]{1,64})$/)?.[1];
  if(oracleId)return oracleMarkets.some(m=>m.id===oracleId)
    ?<Suspense fallback={<PagePending/>}><OracleMarketDetail key={oracleId} id={oracleId} markets={oracleMarkets}/></Suspense>
    :<main id="main" tabIndex={-1} className="page page-task"><div className="state-block"><Inbox aria-hidden="true" strokeWidth={1.75}/><h1>Market not found</h1><Link href="/markets" className="btn btn-primary">All markets</Link></div></main>;
  if(location.startsWith('/markets/'))return <main id="main" tabIndex={-1} className="page page-task"><div className="state-block"><Inbox aria-hidden="true" strokeWidth={1.75}/><h1>Market not found</h1><p>This market is not in the current directory. It may belong to an earlier collection that is no longer listed.</p><Link href="/markets" className="btn btn-primary">All markets</Link></div></main>;
  if(location==='/portfolio')return <main id="main" tabIndex={-1} className="page markets-page portfolio-page">
    <PageHeader title="Your portfolio." lead="All your linked wallet positions. Results and payouts in one place."/>
    {auth.address&&<AccountPortfolio account={auth.address} namespace="all" groups={portfolioGroups}/>}
  </main>;
  return <MarketDirectory directory={directory} snapshot={snapshot}/>;
}

function MarketSkeleton({rows=5}:{rows?:number}){
  return <div className="market-list market-list-skeleton" aria-hidden="true">{Array.from({length:rows},(_,i)=><div className="market-row-skeleton" key={i}><span className="skeleton skeleton-line" style={{width:`${62-(i%3)*9}%`}}/><span className="skeleton skeleton-line" style={{width:'18%'}}/><span className="skeleton" style={{height:36}}/><span className="skeleton" style={{height:36}}/></div>)}</div>;
}

const EMPTY_ORACLE:OracleMarket[]=[],EMPTY_HYBRID:HybridMarket[]=[];

function MarketDirectory({directory,snapshot}:{directory:MarketDirectoryData|null;snapshot:BoardSnapshot|null}){
  const {state:auth}=useAuth();
  const account=auth.address??'';
  const ready=!!directory;
  useEffect(()=>{
    if(!ready)return;
    if('requestIdleCallback' in window){const id=window.requestIdleCallback(warmMarketPages,{timeout:4000});return()=>window.cancelIdleCallback(id);}
    const timer=setTimeout(warmMarketPages,2000);return()=>clearTimeout(timer);
  },[ready]);
  const oracleMarkets=directory?.oracleMarkets??EMPTY_ORACLE,hybridMarkets=directory?.hybridMarkets??EMPTY_HYBRID;
  const [oracleData,setOracleData]=useState<Record<string,OracleMarketSummary>>({}),[hybridData,setHybridData]=useState<Record<string,HybridMarketSummary>>({}),[failed,setFailed]=useState<string[]>([]),[loading,setLoading]=useState(true),[revision,setRevision]=useState(0);
  const [now,setNow]=useState(Date.now());
  const [firstAt,setFirstAt]=useState<number|null>(null),[updatedAt,setUpdatedAt]=useState<number|null>(null);
  const [query,setQuery]=useState<BoardQuery>(()=>readBoardQuery(window.location.search));
  const queryRef=useRef(query);queryRef.current=query;
  const categoryRef=useRef<CategorySlug>(query.category);categoryRef.current=query.category;
  const validSnapshot=snapshot&&(!directory||directoryHash(directory)===snapshot.directoryHash)?snapshot:null;
  const [stableOrder,setStableOrder]=useState<string[]|null>(()=>validSnapshot?validSnapshot.rows.map(r=>r.key):null);
  const [watchlist,setWatchlist]=useState<Set<string>|null>(()=>account?readWatchlist(account):null);
  const [seen]=useState<SeenPrices|null>(()=>{const value=account?readSeen(account):null;return value&&Date.now()-value.savedAt>=SEEN_MIN_AGE_MS?value.prices:null;});
  const knownCategory=useMemo(()=>new Map((snapshot?.rows??[]).map(r=>[r.groupKey,r.category])),[snapshot]);
  const poolCategory=(kind:string,item:OracleMarket|HybridMarket)=>{const pool=item.pool.toLowerCase();return CATEGORY_BY_POOL[pool]??knownCategory.get(`${kind}:${pool}`)??null;};
  useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(t);},[]);
  useEffect(()=>{const timer=setInterval(()=>{if(!document.hidden&&!loading)setRevision(n=>n+1);},45000);return()=>clearInterval(timer);},[loading]);
  useEffect(()=>{
    if(!directory)return;
    const c=new AbortController(),queue:[string,OracleMarket|HybridMarket][]= [...oracleMarkets.map(m=>['oracle',m] as [string,OracleMarket]),...hybridMarkets.map(m=>['hybrid',m] as [string,HybridMarket])];setLoading(true);setFailed([]);
    // The active category's pools load first; four at a time.
    queue.sort((a,b)=>Number(poolCategory(b[0],b[1])===categoryRef.current)-Number(poolCategory(a[0],a[1])===categoryRef.current));
    // Four questions at a time. One unavailable pool never hides the others.
    void Promise.all(Array.from({length:Math.min(4,queue.length)},async()=>{
      while(queue.length&&!c.signal.aborted){const [kind,item]=queue.shift()!,key=kind==='oracle'?`oracle:${(item as OracleMarket).id}`:`hybrid:${(item as HybridMarket).id}`;
        try{
          if(kind==='oracle'){
            const market=item as OracleMarket;
            const response=await appFetch(`/api/oracle/${market.id}/market`,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.any([c.signal,AbortSignal.timeout(20000)])});
            if(!response.ok)throw Error('Oracle quote unavailable');
            const value=await response.json() as OracleMarketSummary;
            if(value.schema!=='flurbo.oracle-market.v1'||value.id!==market.id||typeof value.pool!=='string'||value.pool.toLowerCase()!==market.pool.toLowerCase()||!Number.isSafeInteger(value.marketNow)||typeof value.funded!=='boolean'||typeof value.resolved!=='boolean'||!value.prices||[value.prices.yes,value.prices.no].some(p=>p!==null&&(typeof p!=='string'||!/^\d+$/.test(p))))throw Error('Wrong oracle market');
            if(!c.signal.aborted){setOracleData(old=>({...old,[market.id]:value}));setFirstAt(old=>old??Date.now());}
          }else{
            const market=item as HybridMarket;
            const response=await appFetch(`/api/hybrid/${market.id}/market`,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.any([c.signal,AbortSignal.timeout(20000)])});
            if(!response.ok)throw Error('Market quote unavailable');
            const value=await response.json() as HybridMarketSummary;
            if(value.schema!=='flurbo.hybrid-market.v1'||value.id.toLowerCase()!==market.id.toLowerCase()||value.pool.toLowerCase()!==market.pool.toLowerCase()||!Number.isSafeInteger(value.marketNow)||typeof value.funded!=='boolean'||typeof value.resolved!=='boolean'||!value.prices||[value.prices.yes,value.prices.no].some(p=>p!==null&&(typeof p!=='string'||!/^\d+$/.test(p))))throw Error('Wrong market');
            if(!c.signal.aborted){setHybridData(old=>({...old,[market.id]:value}));setFirstAt(old=>old??Date.now());}
          }
        }catch{if(!c.signal.aborted){if(kind==='oracle'){const id=(item as OracleMarket).id;setOracleData(old=>{const next={...old};delete next[id];return next;});}else{const id=(item as HybridMarket).id;setHybridData(old=>{const next={...old};delete next[id];return next;});}setFailed(old=>[...old,key]);}}
      }
    })).finally(()=>{if(!c.signal.aborted){setLoading(false);setUpdatedAt(Date.now());}});return()=>c.abort();
  },[directory,oracleMarkets,hybridMarkets,revision]);
  // The first visit waits under the loader until pools settle (or three seconds after the first
  // arrives), so late pools do not reorder a list the visitor has started reading.
  useLoadGate('directory-prices',{pending:loading&&!!directory&&!(firstAt!==null&&now-firstAt>3000)&&!validSnapshot?.rows.length,label:'Loading prices'});
  const built=useMemo(()=>buildBoardRows({oracleMarkets,oracleData,hybridMarkets,hybridData,now}),[oracleMarkets,oracleData,hybridMarkets,hybridData,now]);
  const rows=useMemo(()=>{
    if(!validSnapshot)return built;
    const loaded=new Set(built.map(r=>r.groupKey));
    return [...built,...validSnapshot.rows.filter(r=>!loaded.has(r.groupKey)&&!failed.includes(r.groupKey)&&!failed.includes(r.key)).map(rowFromSnapshot)];
  },[built,validSnapshot,failed]);
  const deltas=useMemo(()=>{const map=new Map<string,bigint>();if(!seen)return map;for(const r of built){const d=priceDelta(seen[r.key]?.yes,r.prices?.yes);if(d)map.set(r.key,d.atoms);}return map;},[built,seen]);
  const latest=useRef(built);latest.current=built;
  // Prices seen on this visit become the baseline for the next one.
  useEffect(()=>{
    if(!account)return;
    const save=()=>{const prices:SeenPrices={};for(const r of latest.current)if(r.prices&&(r.prices.yes||r.prices.no))prices[r.key]={yes:r.prices.yes,no:r.prices.no};if(Object.keys(prices).length)writeSeen(account,prices);};
    const onHide=()=>{if(document.visibilityState==='hidden')save();};
    window.addEventListener('pagehide',save);document.addEventListener('visibilitychange',onHide);
    return()=>{save();window.removeEventListener('pagehide',save);document.removeEventListener('visibilitychange',onHide);};
  },[account]);
  useEffect(()=>{if(account&&directory&&!loading&&built.length)writeBoardSnapshot(account,{directoryHash:directoryHash(directory),rows:built.map(toSnapshotRow)});},[account,directory,loading,built]);
  // Board state lives in the URL without adding history entries, so back from a market returns to this exact board.
  const search=useSearch();
  useEffect(()=>{const parsed=readBoardQuery(search);if(writeBoardQuery(parsed)!==writeBoardQuery(queryRef.current))setQuery(parsed);},[search]);
  useEffect(()=>{
    const url='/markets'+writeBoardQuery(query);
    if(window.location.pathname==='/markets'&&window.location.pathname+window.location.search!==url)history.replaceState(history.state,'',url);
    try{sessionStorage.setItem(BOARD_URL_KEY,url);}catch{}
  },[query]);
  const onQuery=useCallback((next:Partial<BoardQuery>)=>{setStableOrder(null);setQuery(old=>({...old,...next,page:next.page??1}));},[]);
  const onWatch=useCallback((key:string)=>{if(account)setWatchlist(toggleWatchlist(account,key));},[account]);
  const pendingPools=loading?oracleMarkets.filter(m=>!oracleData[m.id]&&!failed.includes(`oracle:${m.id}`)).length+hybridMarkets.filter(m=>!hybridData[m.id]&&!failed.includes(`hybrid:${m.id}`)).length:0;
  return <MarketBoard rows={rows} query={query} onQuery={onQuery} now={now/1000} watchlist={watchlist} onWatch={onWatch} deltas={deltas} stableOrder={stableOrder}
    loading={loading} failed={failed.length>0} pendingPools={pendingPools} updatedAt={updatedAt} onRefresh={()=>setRevision(x=>x+1)} unavailable={!rows.length&&failed.length>0}/>;
}
