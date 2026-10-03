import {useEffect,useMemo,useRef,useState} from 'react';
import {Link} from 'wouter';
import {amount,describeClaimAnswers} from '../portfolio';
import {accountOwners,combineHoldings} from '../account-holdings';
import {loadPortfolio,type PoolRead} from '../portfolio-loader';
import {readPortfolioCache,writePortfolioCache} from '../portfolio-cache';
import {accountActivity,positionKey,realizedPerformance,type TradeActivity} from '../portfolio-performance';
import {readPilotPending,type PilotNamespace} from '../pilot';
import type {MarketGroup} from '../market-directory';
import {marketQuestion} from '../showcase-copy';
import Pilot from './Pilot';
import {ArrowUpRight} from 'lucide-react';
import SegmentedControl from '../components/ui/SegmentedControl';
import StatusBadge from '../components/ui/StatusBadge';
import {useLoadGate} from '../loading/gates';
import './portfolio.css';
import {mergeAgentActivity,tradeAgent,type AgentExecution} from '../portfolio-sources';
import EnvioPortfolioSummary from '../components/EnvioPortfolioSummary';

type Selection={namespace:PilotNamespace;scope:number;mask:string};
const signed=(n:bigint)=>(n<0n?'-':n>0n?'+':'')+amount(String(n<0n?-n:n));
const NO_EXECUTIONS:AgentExecution[]=[];
export default function PortfolioDashboard({account,wallets,groups,manualWallets=wallets,agentExecutions=NO_EXECUTIONS,onRefreshSources}:{account:string;wallets:string[];groups:MarketGroup[];manualWallets?:string[];agentExecutions?:AgentExecution[];onRefreshSources?:()=>Promise<void>}){
  const [data,setData]=useState<Record<string,PoolRead>>({}),[busy,setBusy]=useState(true),[revision,setRevision]=useState(0),[historyOnly,setHistoryOnly]=useState(false);
  const [tab,setTab]=useState<'Holdings'|'Activity'|'Collected'|'Performance'>('Holdings'),[filter,setFilter]=useState('All'),[kind,setKind]=useState('All types'),[page,setPage]=useState(0),[payoutBusy,setPayoutBusy]=useState(false);
  const [selection,setSelection]=useState<Selection|null>(()=>{
    for(const group of groups)try{const p=readPilotPending(group.namespace);if(p?.login===account&&p.review.requested.action==='redeem')return {namespace:group.namespace,scope:p.review.requested.scope!,mask:p.review.requested.mask!};}catch{return {namespace:group.namespace,scope:1,mask:'2'};}
    return null;
  });
  const identity=accountOwners(account,wallets).join(',');
  const automaticScans=useRef(0),lastProgress=useRef('');
  useEffect(()=>{
    const c=new AbortController();setBusy(true);
    // Retain the last verified snapshot while refreshing instead of flashing zero.
    void loadPortfolio({account,wallets,groups,agentExecutions,signal:c.signal,historyOnly,previous:data,publish:(namespace,value)=>setData(old=>({...old,[namespace]:value}))}).finally(()=>{if(!c.signal.aborted)setBusy(false);});
    return()=>c.abort();
  // data is the previous snapshot only when the user asks to continue history.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[account,identity,groups,revision]);
  const refresh=async()=>{automaticScans.current=0;lastProgress.current='';await onRefreshSources?.();setHistoryOnly(false);setRevision(x=>x+1);};
  // The previous visit's holdings show at once; each market switches to fresh balances when its read completes.
  const cache=useMemo(()=>readPortfolioCache(account,identity),[account,identity]);
  useEffect(()=>{for(const [namespace,read] of Object.entries(data))writePortfolioCache(account,identity,namespace,read);},[data,account,identity]);
  const current=useMemo(()=>{
    const out:Record<string,PoolRead>={};
    for(const g of groups){
      const fresh=data[g.namespace],old=cache[g.namespace];
      const view=fresh&&(fresh.holdingsComplete||fresh.error)||!old||old.group.pool!==g.pool?fresh:{...old,manifest:fresh?.manifest??old.manifest,history:fresh?.history,payouts:fresh?.payouts,historyError:fresh?.historyError,payoutError:fresh?.payoutError};
      if(view)out[g.namespace]=view;
    }
    return out;
  },[data,cache,groups]);
  const cachedAt=Math.min(...Object.values(current).map(r=>r.cachedAt??Infinity));
  // Your own wallets combine into one row per prediction; each agent wallet keeps its own row, so an agent's
  // trade is never merged with yours or another agent's.
  const own=useMemo(()=>new Set(accountOwners(account,manualWallets)),[account,manualWallets]);
  const rows=groups.flatMap(group=>{
    const read=current[group.namespace];if(!read)return [];
    const entries=Object.entries(read.owners),mine=entries.filter(([owner])=>own.has(owner)).map(([,list])=>list);
    return [...combineHoldings(mine).map(row=>({...row,group,read,holder:null as string|null})),
      ...entries.filter(([owner])=>!own.has(owner)).flatMap(([owner,list])=>combineHoldings([list]).map(row=>({...row,group,read,holder:owner as string|null})))];
  });
  const allHoldings=groups.every(g=>data[g.namespace]?.holdingsComplete),failed=Object.values(data).some(d=>d.error),allHistory=groups.every(g=>data[g.namespace]?.history?.complete&&!data[g.namespace]?.historyError);
  useEffect(()=>{
    if(busy||payoutBusy||allHistory||automaticScans.current>=5)return;
    const progress=groups.map(g=>[g.namespace,data[g.namespace]?.history?.through,data[g.namespace]?.history?.logs.length].join(':')).join('|');
    if(Object.values(data).some(d=>d.historyError)||progress===lastProgress.current)return;
    const timer=setTimeout(()=>{if(document.hidden)return;lastProgress.current=progress;automaticScans.current++;setHistoryOnly(true);setRevision(x=>x+1);},3000);
    return()=>clearTimeout(timer);
  },[busy,payoutBusy,allHistory,data,groups]);
  useLoadGate('portfolio',{pending:busy&&!rows.length&&!Object.values(data).some(d=>d.holdingsComplete||d.error),label:'Loading your holdings'});
  const allPayouts=groups.every(g=>data[g.namespace]?.payouts?.complete&&!data[g.namespace]?.payoutError);
  const payoutReadFailed=Object.values(data).some(d=>d.payoutError);
  const trades=useMemo(()=>mergeAgentActivity(groups.flatMap(g=>accountActivity(g.namespace,g.pool,[...(data[g.namespace]?.history?.logs||[]),...(data[g.namespace]?.payouts?.logs||[])],identity.split(','))),agentExecutions.filter(e=>groups.some(g=>g.pool===e.pool))),[data,groups,identity,agentExecutions]);
  const performance=useMemo(()=>realizedPerformance(trades),[trades]);
  const balances=new Map<string,bigint>();for(const read of Object.values(data))for(const [owner,values] of Object.entries(read.owners))for(const row of values)balances.set(positionKey(read.group.pool,owner,row.scope,row.mask),BigInt(row.quantity));
  const basisMatches=allHoldings&&[...balances].every(([key,q])=>(performance.inventory.get(key)?.quantity||0n)===q)&&[...performance.inventory].every(([key,v])=>(balances.get(key)||0n)===v.quantity);
  const pnlReady=allHistory&&performance.valid&&basisMatches;
  const payout=rows.reduce((sum,row)=>sum+BigInt(row.payoutAtoms||0),0n);
  const label=(namespace:string,scope:number)=>current[namespace]?.manifest?.publication.draft.events.filter((_e,i)=>scope&(1<<i)).map(marketQuestion).join(' + ')||'Prediction';
  const tradingOpen=(row:typeof rows[number])=>row.group.closesAt>Date.now()/1000;
  const state=(row:typeof rows[number])=>row.payoutAtoms===null?(tradingOpen(row)?'Open for trading':'Awaiting settlement'):BigInt(row.payoutAtoms)>0n?'Ready to collect':'No payout';
  const filtered=rows.filter(row=>filter==='All'||filter==='Ready to collect'&&BigInt(row.payoutAtoms||0)>0n||filter==='Unsettled'&&row.payoutAtoms===null||filter==='Settled'&&row.payoutAtoms!==null);
  const selectedRead=selection?data[selection.namespace]:null;
  const payoutOwners=selection&&selectedRead?manualWallets.filter(owner=>selectedRead.owners[owner.toLowerCase()]?.some(row=>row.scope===selection.scope&&row.mask===selection.mask&&BigInt(row.payoutAtoms||0)>0n)):[];
  // The agent that holds this row: named from its verified trades, or by wallet when none is listed yet.
  const holdingAgents=(row:typeof rows[number])=>{
    if(!row.holder)return [];
    const named=agentExecutions.find(e=>e.owner===row.holder);
    return [named?{agentId:named.agentId,agentName:named.agentName}:{agentId:'',agentName:`agent wallet ${row.holder.slice(0,6)}...${row.holder.slice(-4)}`}];
  };
  const collected=trades.filter(t=>t.action==='Payout');
  const collectedTotal=collected.reduce((sum,t)=>sum+t.cash,0n);
  const activity=tab==='Collected'?collected:trades;
  const shown=[...activity].reverse().slice(page*20,page*20+20);
  const kindOf=(row:typeof rows[number])=>row.holder?'Agent':(row.scope&(row.scope-1))?'Combined':'Individual';
  const visible=filtered.filter(row=>kind==='All types'||kindOf(row)===kind);
  const holdingsKnown=allHoldings||rows.length>0;
  return <div className="unified-portfolio portfolio-view">
    <div className="portfolio-dashboard-toolbar"><p className="freshness" role="status">{busy?<><span className="progress-line portfolio-progress" aria-hidden="true"/>{Number.isFinite(cachedAt)?`Showing your holdings from ${new Date(cachedAt).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}. Checking for changes...`:'Updating your account...'}</>:failed?'Some balances need another check.':'Your trades and agent positions, together.'}</p><button className="btn btn-secondary btn-sm" disabled={payoutBusy||busy} onClick={refresh}>{busy?'Refreshing...':'Refresh'}</button></div>
    {failed&&<p role="alert" className="state-inline error portfolio-load-notice">Some shares could not be refreshed. Showing verified balances only. Refresh to retry.</p>}
    <div className="portfolio-summary-grid">
      <article><span>Active positions</span>{holdingsKnown?<strong>{rows.length}</strong>:failed&&!busy?<strong>Unavailable</strong>:<span className="skeleton portfolio-figure-skeleton" aria-hidden="true"/>}<small>{allHoldings?'Individual and combined holdings':holdingsKnown?'More balances loading':failed&&!busy?'Refresh to check balances':'Checking balances'}</small></article>
      <article className={payout>0n?'is-collectible':''}><span>Ready to collect</span>{allHoldings||payout>0n?<strong>{amount(String(payout))}</strong>:failed&&!busy?<strong>Unavailable</strong>:<span className="skeleton portfolio-figure-skeleton" aria-hidden="true"/>}<small>{!allHoldings&&payout===0n&&failed&&!busy?'Refresh to check payouts':`Test AUSD${!allHoldings?', partial total':''}`}</small>{payout>0n&&<button className="text-link" onClick={()=>{setTab('Holdings');setFilter('Ready to collect');setKind('All types');}}>Show collectible shares</button>}</article>
      <article><span>Payouts collected</span>{collected.length||allPayouts||payoutReadFailed?<strong>{collected.length?amount(String(collectedTotal)):allPayouts?'0':'Unavailable'}</strong>:<span className="skeleton portfolio-figure-skeleton" aria-hidden="true"/>}<small>{allPayouts?'Test AUSD received':collected.length?'Test AUSD found so far':payoutReadFailed?'Refresh to check past payouts':'Reading payout transactions'}</small>{collected.length>0&&<button className="portfolio-collected-link text-link" onClick={()=>{setTab('Collected');setPage(0);}}>View collected payouts</button>}</article>
    </div>
    <div className="portfolio-tabs tabs" role="group" aria-label="Portfolio views">{(['Holdings','Activity','Collected','Performance'] as const).map(value=><button key={value} type="button" aria-pressed={tab===value} onClick={()=>{setTab(value);setPage(0);}}>{value}{value==='Holdings'&&holdingsKnown?' · '+rows.length:''}</button>)}</div>
    {tab==='Performance'?<><section className="portfolio-performance" aria-label="Realized PnL">
      <div className="portfolio-section-heading"><h2>Realized profit / loss</h2><span className="chip">Test AUSD</span></div>
      {pnlReady&&performance.points.length>0?<PnlChart points={performance.points}/>:<div className="state-block portfolio-chart-empty"><p>{!pnlReady?'Your chart will appear when trading history is verified.':'No realized profit or loss yet.'}</p><small className="muted">{pnlReady?'Sales and collected payouts will appear here.':'Your holdings can be used while earlier activity loads.'}</small></div>}
      <details className="portfolio-method disclosure"><summary>How this is calculated</summary><p>Sale proceeds and collected payouts, minus the average purchase cost of those shares. Open positions and uncollected payouts are excluded. Test MON gas is excluded. Cost basis is calculated separately for each owning wallet before totals are combined.</p><p>History must be complete and match current holdings. Missing purchases, wrapped or transferred positions can prevent a reliable calculation. The chart follows confirmed sales and payouts, not daily account value.</p></details>
    </section></>:tab==='Holdings'?<section aria-label="Your shares"><div className="portfolio-section-heading"><h2>Your shares</h2></div>
      <div className="portfolio-filters">
        <SegmentedControl label="Show" value={filter} options={['All','Unsettled','Ready to collect','Settled'].map(f=>({value:f,label:f}))} onChange={setFilter}/>
        <SegmentedControl label="Type" value={kind} options={['All types','Individual','Combined','Agent'].map(f=>({value:f,label:f}))} onChange={setKind}/>
      </div>
      <div className="portfolio-table unified-holdings"><table className="data-table"><thead><tr><th scope="col">Prediction</th><th scope="col" className="num">Shares</th><th scope="col">Status</th><th scope="col" className="num">Payout</th><th scope="col"><span className="sr-only">Action</span></th></tr></thead><tbody>{visible.map(row=>{const status=state(row);return <tr key={`${row.group.pool}:${row.holder??'own'}:${row.scope}:${row.mask}`}><td><Link href={`/markets/${row.group.namespace}/${Math.log2(row.scope&-row.scope)}`}><strong>{label(row.group.namespace,row.scope)}</strong></Link><small>{describeClaimAnswers(row.scope,Number(row.mask))}</small>{holdingAgents(row).length>0&&<span className="holding-meta">{holdingAgents(row).map(agent=><AgentLabel key={agent.agentId} agent={agent}/>)}</span>}</td><td className="num"><span className="holding-mobile-label" aria-hidden="true">Shares</span>{amount(row.quantity)}</td><td><span className="holding-mobile-label" aria-hidden="true">Status</span><StatusBadge kind={status==='Ready to collect'?'collect':status==='No payout'?'nopayout':status==='Open for trading'?'open':'waiting'}>{status}</StatusBadge></td><td className="num"><span className="holding-mobile-label" aria-hidden="true">Payout</span>{row.payoutAtoms===null?<span className="muted">Not known yet</span>:<strong>{amount(row.payoutAtoms)} test AUSD</strong>}</td><td className="holding-action">{!row.read.cachedAt&&row.payoutAtoms!==null&&BigInt(row.payoutAtoms)>0n&&!row.holder&&manualWallets.some(owner=>row.read.owners[owner.toLowerCase()]?.some(p=>p.scope===row.scope&&p.mask===row.mask&&BigInt(p.payoutAtoms||0)>0n))&&<button className="btn btn-primary btn-sm holding-collect" disabled={payoutBusy||!!selection} onClick={()=>setSelection({namespace:row.group.namespace,scope:row.scope,mask:row.mask})}>Collect payout</button>}</td></tr>;})}</tbody></table></div>
      {!visible.length&&<div className="state-block portfolio-empty"><p role="status">{busy&&!allHoldings?'Checking your shares...':!allHoldings?'Balances are incomplete. Refresh to try again.':rows.length?'No positions match this filter.':'No shares yet. Your first prediction will appear here.'}</p><Link href="/markets" className="text-link">Explore markets</Link></div>}
    </section>:<section aria-label={tab==='Collected'?'Your collected payouts':'Your trading activity'}>{tab==='Activity'&&<EnvioPortfolioSummary pools={groups.map(group=>group.pool)} traders={identity.split(',')}/>}<div className="portfolio-section-heading"><h2>{tab==='Collected'?'Collected payouts':'Your trades'}</h2><span className="muted">{tab==='Collected'?(allPayouts?'Verified payout transactions':payoutReadFailed?'Payout history unavailable':'Checking payout history'):(allHistory?'Indexed activity':'History still loading')}</span></div><div className="portfolio-table portfolio-activity"><table className="data-table compact"><thead><tr><th scope="col">Prediction / action</th><th scope="col" className="num">Shares</th><th scope="col" className="num">Test AUSD</th><th scope="col">Transaction</th></tr></thead><tbody>{shown.map(trade=><tr key={`${trade.pool}:${trade.hash}:${trade.index}`}><td><span className="portfolio-tag">{trade.action==='Payout'?'Collected':trade.action}</span><strong>{label(trade.namespace,trade.scope)}</strong><small>{describeClaimAnswers(trade.scope,Number(trade.mask))}</small><AgentLabel agent={tradeAgent(trade,agentExecutions)}/></td><td className="num">{amount(String(trade.quantity))}</td><td className="num">{trade.action==='Buy'?'-':'+'}{amount(String(trade.cash))}</td><td><a className="text-link" href={`https://testnet.monadexplorer.com/tx/${trade.hash}`} target="_blank" rel="noreferrer">View transaction <ArrowUpRight aria-hidden="true" strokeWidth={1.75}/></a><small>{trade.timestamp?new Date(trade.timestamp*1000).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'Time unavailable'}</small><details><summary>Transaction details</summary><small>Block {trade.block.toLocaleString()}</small></details></td></tr>)}</tbody></table></div>{!shown.length&&<p className="portfolio-footnote">{tab==='Collected'?(allPayouts?'No payouts collected yet.':payoutReadFailed?'Past payouts could not be checked. Refresh to retry. Your funds and current holdings are unaffected.':'Checking previous payout transactions. Zero remaining shares does not mean no payout was collected.'):(allHistory?'No confirmed trades found for your linked wallets.':'Confirmed trades will appear as history loads.')}</p>}<div className="portfolio-pagination"><button className="btn btn-secondary btn-sm" disabled={!page} onClick={()=>setPage(p=>p-1)}>Previous</button><span className="num">{activity.length?`${page*20+1} to ${Math.min(activity.length,page*20+20)} of ${activity.length}`:`Page ${page+1}`}</span><button className="btn btn-secondary btn-sm" disabled={(page+1)*20>=activity.length} onClick={()=>setPage(p=>p+1)}>Next</button></div></section>}
    {rows.some(row=>BigInt(row.payoutAtoms||0)>0n&&!!row.holder)&&<p className="portfolio-footnote">Agent wallet payouts must be collected by that wallet through its agent runtime.</p>}
    {!allHistory&&<div className="portfolio-history-notice"><p>{busy?'Loading earlier activity in the background.':'Earlier activity is still being verified. Current holdings and collected payouts remain available.'}</p>{!busy&&<button className="btn btn-secondary btn-sm" disabled={payoutBusy} onClick={()=>{automaticScans.current=0;lastProgress.current='';setHistoryOnly(true);setRevision(x=>x+1);}}>Retry activity</button>}</div>}
    {selection&&<section className="portfolio-payout-panel"><Pilot key={`${selection.namespace}:${selection.scope}:${selection.mask}`} namespace={selection.namespace} payout={{scope:selection.scope,mask:selection.mask,owners:payoutOwners.map(x=>x.toLowerCase()),title:label(selection.namespace,selection.scope)+' · '+describeClaimAnswers(selection.scope,Number(selection.mask))}} onBusy={setPayoutBusy} onTradeConfirmed={refresh}/><button className="btn btn-secondary" disabled={payoutBusy} onClick={()=>setSelection(null)}>Close payout</button></section>}
  </div>;
}

function AgentLabel({agent}:{agent?:Pick<AgentExecution,'agentId'|'agentName'>}){return !agent?null:agent.agentId?<Link className="portfolio-agent-label" href={`/agents/${agent.agentId}`}>Via {agent.agentName}</Link>:<span className="portfolio-agent-label">Via {agent.agentName}</span>;}

function PnlChart({points}:{points:{trade:TradeActivity;value:bigint}[]}){
  const box=useRef<HTMLDivElement>(null),[width,setWidth]=useState(760),[hover,setHover]=useState<number|null>(null);
  useEffect(()=>{const observer=new ResizeObserver(entries=>setWidth(Math.max(280,Math.min(1100,entries[0].contentRect.width))));if(box.current)observer.observe(box.current);return()=>observer.disconnect();},[]);
  const values=[0,...points.map(p=>Number(p.value)/1e6)],low=Math.min(...values),high=Math.max(...values),range=high-low||1;
  const tick=(n:number)=>new Intl.NumberFormat(undefined,{notation:Math.abs(n)>=10000?'compact':'standard',maximumFractionDigits:2}).format(n);
  const x=(i:number)=>60+i/Math.max(1,values.length-1)*(width-80),y=(v:number)=>200-(v-low)/range*160;
  const selected=hover===null?points.at(-1)!:points[hover]||points.at(-1)!;
  return <div className="portfolio-pnl-chart" ref={box}><svg viewBox={`0 0 ${width} 245`} role="img" aria-label={`Realized PnL after ${points.length} confirmed sales and payouts: ${signed(points.at(-1)!.value)} test AUSD`}>
    {[low,low+range/2,low+range].map((v,i)=><g key={i}><line x1="60" x2={width-20} y1={y(v)} y2={y(v)} stroke="currentColor" opacity=".12"/><text x="48" y={y(v)+4} textAnchor="end">{tick(v)}</text></g>)}
    <polyline points={values.map((v,i)=>`${x(i)},${y(v)}`).join(' ')} fill="none" stroke="var(--forest)" strokeWidth="3"/>
    {points.map((p,i)=><circle key={p.trade.hash+':'+p.trade.index} cx={x(i+1)} cy={y(Number(p.value)/1e6)} r="5" fill="var(--forest)" tabIndex={0} role="button" aria-label={`Exit ${i+1}: ${signed(p.value)} test AUSD`} onMouseEnter={()=>setHover(i)} onFocus={()=>setHover(i)} onClick={()=>setHover(i)}><title>{signed(p.value)} test AUSD · Block {p.trade.block}</title></circle>)}
    <text x="60" y="232">Start</text><text x={width-20} y="232" textAnchor="end">{points.length} confirmed exits</text>
  </svg><p className="portfolio-chart-caption">{signed(selected.value)} test AUSD <span>after {selected.trade.action.toLowerCase()} at block {selected.trade.block.toLocaleString()}</span></p></div>;
}
