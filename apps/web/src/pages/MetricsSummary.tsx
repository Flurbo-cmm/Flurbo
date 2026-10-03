import {useEffect,useState} from 'react';
import {Link} from 'wouter';
import {loadMetrics,share,type MetricsReport} from '../admin-metrics';
import {Funnel} from '../components/MetricsCharts';
import './metrics.css';

// Operator only: the member funnel above the access queue, with a link to the detailed page.
export default function MetricsSummary(){
  const [report,setReport]=useState<MetricsReport|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(true);
  async function load(){setBusy(true);setError('');try{setReport(await loadMetrics());}catch(e){setError(e instanceof Error?e.message:'Metrics could not be loaded.');}finally{setBusy(false);}}
  useEffect(()=>{void load();},[]);
  const d=report?.last24h;
  return <section className="panel metrics-summary" aria-label="Member metrics" aria-busy={busy}>
    <div className="metrics-summary-head"><h2>Metrics</h2><span className="field-help">Operator only · team accounts excluded</span></div>
    {report&&<>
      <Funnel steps={report.funnel}/>
      <p className="metrics-summary-line">Last 24 hours: {d!.signIns} new sign-ins, {d!.requests} requests, {d!.approvals} approvals, {d!.bets} bets ({d!.singles} single, {d!.combined} combined).
        {' '}All bets: {report.totals.buys}, {share(report.totals.combined,report.totals.buys)} combined.</p>
      {[report.funds?.dispenser,report.funds?.starter].some(w=>w?.low)&&<p role="alert" className="state-inline error">Test funds for new members are running low. See Detailed metrics.</p>}
      {report.unlinked.length>0&&<p role="alert" className="state-inline error">{report.unlinked.length} wallet{report.unlinked.length===1?'':'s'} traded without a linked Flurbo account. See details.</p>}
      {!report.sync.complete&&<p className="field-help">Trade data is still being scanned, so bet counts may be low.</p>}
      {report.notes.applications!=='ok'&&<p className="field-help">Application numbers are unavailable{report.notes.applications==='unavailable'?'. Run migration 002 in Supabase':''}.</p>}
    </>}
    {error&&<p role="alert" className="state-inline error">{error}</p>}
    <div className="access-actions"><Link href="/metrics" className="btn btn-secondary">Detailed metrics</Link><button className="text-link" disabled={busy} onClick={()=>void load()}>{busy?'Loading…':'Refresh'}</button></div>
  </section>;
}
