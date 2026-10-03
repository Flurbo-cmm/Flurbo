import {useEffect,useMemo,useState} from 'react';
import {Link} from 'wouter';
import PageHeader from '../components/PageHeader';
import SegmentedControl from '../components/ui/SegmentedControl';
import {Funnel,DailyBets} from '../components/MetricsCharts';
import {loadMetrics,scanMoreTrades,ausd,short,when,share,RULE_LABELS,type MetricsReport,type MetricsUser} from '../admin-metrics';
import './metrics.css';

type Filter='all'|'traded'|'approved-idle'|'waiting';
type Sort='last-bet'|'most-bets'|'combined-share'|'newest';
const FILTERS:[Filter,string][]=[['all','Everyone'],['traded','Made a bet'],['approved-idle','Approved, no bet yet'],['waiting','Waiting for access']];
const SORTS:[Sort,string][]=[['last-bet','Latest bet'],['most-bets','Most bets'],['combined-share','Most combined'],['newest','Newest sign-in']];

function accessLabel(u:MetricsUser){
  if(u.team)return 'Team';
  if(u.approved)return 'Approved';
  const s=u.application?.state;
  return !s?'No request':s==='unverified'?'Email not verified':s==='pending'?'Waiting for review':s[0].toUpperCase()+s.slice(1);
}

// Operator only (server and route both check the operator passkey account). Detailed member behaviour:
// the funnel, daily activity, and for each member how they bet, individual answers or combinations.
export default function Metrics(){
  const [report,setReport]=useState<MetricsReport|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(true),[notice,setNotice]=useState('');
  const [filter,setFilter]=useState<Filter>('all'),[sort,setSort]=useState<Sort>('last-bet'),[showTeam,setShowTeam]=useState(false);
  async function run(fn:()=>Promise<void>){setBusy(true);setError('');setNotice('');try{await fn();}catch(e){setError(e instanceof Error?e.message:'Try again.');}finally{setBusy(false);}}
  const load=()=>run(async()=>setReport(await loadMetrics()));
  useEffect(()=>{void load();},[]);

  const members=useMemo(()=>(report?.users||[]).filter(u=>showTeam||!u.team),[report,showTeam]);
  const rows=useMemo(()=>{
    const list=members.filter(u=>filter==='all'||filter==='traded'&&u.trades.buys>0||filter==='approved-idle'&&u.approved&&!u.team&&u.trades.buys===0||filter==='waiting'&&!u.approved&&!u.team);
    const key:Record<Sort,(u:MetricsUser)=>number>={'last-bet':u=>u.trades.lastBuyAt??-1,'most-bets':u=>u.trades.buys,'combined-share':u=>u.trades.buys?u.trades.combined/u.trades.buys:-1,'newest':u=>u.firstSignIn??-1};
    return [...list].sort((a,b)=>key[sort](b)-key[sort](a));
  },[members,filter,sort]);
  const style=useMemo(()=>{
    const bettors=(report?.users||[]).filter(u=>!u.team&&u.trades.buys>0);
    return {bettors:bettors.length,onlySingle:bettors.filter(u=>u.trades.combined===0).length,onlyCombined:bettors.filter(u=>u.trades.singles===0).length,
      both:bettors.filter(u=>u.trades.singles>0&&u.trades.combined>0).length,
      repeat:bettors.filter(u=>u.trades.buys>1).length,
      average:bettors.length?(bettors.reduce((n,u)=>n+u.trades.buys,0)/bettors.length).toFixed(1):'0'};
  },[report]);

  const f=report?Object.fromEntries(report.funnel.map(s=>[s.key,s.count])):{};
  return <main id="main" tabIndex={-1} className="page metrics-page" aria-busy={busy}>
    <PageHeader back={<Link href="/access" className="text-link">Back to your account</Link>} title="Metrics" lead="Operator only. Team and test accounts are excluded from every count unless you show them."
      actions={<div className="access-actions">
        {report&&!report.sync.complete&&<button className="btn btn-secondary" disabled={busy} onClick={()=>void run(async()=>{const r=await scanMoreTrades();setReport(await loadMetrics());setNotice(r.sync.complete?'Trade data is up to date.':'Scanned more blocks. Trade data is still catching up.');})}>Scan more trades</button>}
        <button className="btn btn-primary" disabled={busy} onClick={()=>void load()}>{busy?'Loading…':'Refresh'}</button></div>}/>
    {error&&<p role="alert" className="state-inline error">{error}</p>}{notice&&<p role="status" className="field-help">{notice}</p>}
    {report&&<>
      <section className="metrics-tiles" aria-label="Headline numbers">
        {[['Signed in',f.signedIn],['Access granted',f.granted],['Made a bet',f.traded],['Bet in last 7 days',f.active7d],['Bets placed',report.totals.buys],['Combined bets',share(report.totals.combined,report.totals.buys)]].map(([label,value])=>
          <div key={label as string} className="metrics-tile"><span>{label}</span><strong>{value}</strong></div>)}
      </section>
      {report.funds&&<section className="panel" aria-labelledby="funds-h"><h2 id="funds-h">Test funds for new members</h2>
        <dl className="metrics-facts">{([['AUSD dispenser',report.funds.dispenser],['Starter MON wallet',report.funds.starter]] as const).filter(([,w])=>w).map(([name,w])=>
          <div key={name}><dt>{name} <code title={w!.address}>{short(w!.address)}</code></dt><dd className={w!.low?'metrics-low':''}>{Number(w!.balance).toLocaleString(undefined,{maximumFractionDigits:2})} {w!.unit} <small>about {w!.left} {w!.leftLabel} left{w!.low?` · below ${w!.threshold}, top up`:''}</small></dd></div>)}</dl>
        <p className="field-help">Checked {when(report.funds.checkedAt)}. The operator is emailed when either drops below its threshold.</p></section>}
      {!report.sync.complete&&<p className="callout">Trade data is still being scanned from the chain, so bet counts may be low. It catches up every two minutes; progress is in Markets below.</p>}
      {report.unlinked.length>0&&<p role="alert" className="callout metrics-alert"><strong>{report.unlinked.length} wallet{report.unlinked.length===1?'':'s'} traded without a linked Flurbo account.</strong> The website refuses these trades, so someone is calling the contracts directly. See Unlinked wallets below.</p>}

      <div className="metrics-grid-2">
        <section className="panel" aria-labelledby="funnel-h"><h2 id="funnel-h">Funnel</h2><Funnel steps={report.funnel}/>
          {report.funnel[1]?.detail&&<p className="field-help">{report.funnel[1].detail.emailVerified} verified their email · {report.funnel[1].detail.withdrawn} withdrew a request.</p>}</section>
        <section className="panel" aria-labelledby="style-h"><h2 id="style-h">How members bet</h2>
          <dl className="metrics-facts">
            <div><dt>Only single answers</dt><dd>{style.onlySingle} <small>{share(style.onlySingle,style.bettors)}</small></dd></div>
            <div><dt>Only combinations</dt><dd>{style.onlyCombined} <small>{share(style.onlyCombined,style.bettors)}</small></dd></div>
            <div><dt>Both</dt><dd>{style.both} <small>{share(style.both,style.bettors)}</small></dd></div>
            <div><dt>Bet more than once</dt><dd>{style.repeat} <small>{share(style.repeat,style.bettors)}</small></dd></div>
            <div><dt>Bets per bettor</dt><dd>{style.average}</dd></div>
          </dl>
          <h3>Bets by type</h3>
          <ul className="metrics-rules">{Object.entries(report.totals.byRule).sort((a,b)=>b[1]-a[1]).map(([rule,n])=><li key={rule}><span>{RULE_LABELS[rule]||rule}</span><strong>{n}</strong><small>{share(n,report.totals.buys)}</small></li>)}
            {!report.totals.buys&&<li><span>No bets yet</span></li>}</ul>
        </section>
      </div>

      <section className="panel"><DailyBets rows={report.daily}/></section>

      <section className="panel" aria-labelledby="members-h">
        <div className="metrics-section-head"><h2 id="members-h">Members</h2>
          <div className="metrics-controls">
            <SegmentedControl<Filter> label="Filter members" hideLabel value={filter} options={FILTERS.map(([value,label])=>({value,label}))} onChange={setFilter}/>
            <label>Sort <select value={sort} onChange={e=>setSort(e.target.value as Sort)}>{SORTS.map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
            <label className="check-row"><input type="checkbox" checked={showTeam} onChange={e=>setShowTeam(e.target.checked)}/>Show team accounts</label>
          </div></div>
        <div className="metrics-scroll"><table className="metrics-table">
          <thead><tr><th>Mera account</th><th>First sign-in</th><th>Access</th><th>Wallets</th><th>Starter MON</th><th>Bets</th><th>Single</th><th>Combined</th><th>Combined share</th><th>AUSD spent</th><th>Markets</th><th>Last bet</th></tr></thead>
          <tbody>{rows.map(u=><tr key={u.account} className={u.team?'metrics-team':''}>
            <td><code title={u.account}>{short(u.account)}</code></td><td>{when(u.firstSignIn)}</td><td>{accessLabel(u)}</td><td>{u.wallets}</td><td>{u.starter?'Sent':'—'}</td>
            <td>{u.trades.buys}</td><td>{u.trades.singles}</td><td>{u.trades.combined}</td><td>{share(u.trades.combined,u.trades.buys)}</td><td>{ausd(u.trades.spentAtoms)}</td><td>{u.trades.markets}</td><td>{when(u.trades.lastBuyAt)}</td></tr>)}
            {!rows.length&&<tr><td colSpan={12}>No members match this filter.</td></tr>}</tbody></table></div>
        <p className="field-help">Sign-ins are recorded from {when(report.notes.signInsTrackedSince)}. Earlier members appear once they request access, link a wallet or bet. Times are in your local time zone.</p>
      </section>

      <section className="panel" aria-labelledby="markets-h"><h2 id="markets-h">Markets</h2>
        <div className="metrics-scroll"><table className="metrics-table">
          <thead><tr><th>Market</th><th>Bettors</th><th>Bets</th><th>Single</th><th>Combined</th><th>AUSD in</th><th>Sells</th><th>Redeemed</th><th>Trade data</th></tr></thead>
          <tbody>{report.markets.map(m=><tr key={m.namespace}><td>{m.label}</td><td>{m.traders}</td><td>{m.buys}</td><td>{m.singles}</td><td>{m.combined}</td><td>{ausd(m.spentAtoms)}</td><td>{m.sells}</td><td>{m.redeems}</td>
            <td>{m.scanned.complete?'Up to date':`Scanning, ${m.scanned.percent}%`}</td></tr>)}</tbody></table></div>
      </section>

      {report.agents.length>0&&<section className="panel" aria-labelledby="agents-h"><h2 id="agents-h">Agents</h2>
        <div className="metrics-scroll"><table className="metrics-table"><thead><tr><th>Agent wallet</th><th>Owner</th><th>Bets</th><th>Single</th><th>Combined</th><th>AUSD spent</th><th>Last bet</th></tr></thead>
          <tbody>{report.agents.map(a=><tr key={a.wallet+(a.agentId||'')}><td><code title={a.wallet}>{short(a.wallet)}</code></td><td>{a.account?<code title={a.account}>{short(a.account)}</code>:'Unknown'}</td><td>{a.trades.buys}</td><td>{a.trades.singles}</td><td>{a.trades.combined}</td><td>{ausd(a.trades.spentAtoms)}</td><td>{when(a.trades.lastBuyAt)}</td></tr>)}</tbody></table></div></section>}

      <section className="panel" aria-labelledby="unlinked-h"><h2 id="unlinked-h">Unlinked wallets</h2>
        {report.unlinked.length?<div className="metrics-scroll"><table className="metrics-table"><thead><tr><th>Wallet</th><th>Bets</th><th>Sells</th><th>Redeemed</th><th>AUSD spent</th><th>Last bet</th></tr></thead>
          <tbody>{report.unlinked.map(u=><tr key={u.wallet}><td><a className="text-link" href={`https://testnet.monadscan.com/address/${u.wallet}`} target="_blank" rel="noreferrer"><code>{short(u.wallet)}</code></a></td><td>{u.trades.buys}</td><td>{u.trades.sells}</td><td>{u.trades.redeems}</td><td>{ausd(u.trades.spentAtoms)}</td><td>{when(u.trades.lastBuyAt)}</td></tr>)}</tbody></table></div>
          :<p className="field-help">None. Every trade came from a wallet linked to a Flurbo account, an agent, or the team.</p>}
      </section>
      <p className="field-help">Updated {when(report.generatedAt)}. {report.notes.excludedAccounts} team account{report.notes.excludedAccounts===1?' is':'s are'} excluded. Application numbers: {report.notes.applications==='ok'?'loaded':report.notes.applications==='unavailable'?'unavailable, run migration 002 in Supabase':'not configured'}.</p>
    </>}
  </main>;
}
