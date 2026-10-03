import {useState} from 'react';
import type {DailyRow,FunnelStep} from '../admin-metrics';
import {share} from '../admin-metrics';

// Funnel: one magnitude per step, one hue. Each bar is labelled with its count and the share of the step above.
export function Funnel({steps}:{steps:FunnelStep[]}){
  const top=Math.max(1,...steps.map(s=>s.count));
  return <ol className="metrics-funnel" aria-label="Member funnel">
    {steps.map((step,i)=><li key={step.key}>
      <span className="metrics-funnel-label">{step.label}</span>
      <span className="metrics-funnel-track" aria-hidden="true"><span className="metrics-funnel-bar" style={{width:`${Math.max(step.count?2:0,step.count*100/top)}%`}}/></span>
      <span className="metrics-funnel-value"><strong>{step.count}</strong>{i>0&&<small>{share(step.count,steps[i-1].count)} of above</small>}</span>
    </li>)}
  </ol>;
}

// Bets per day, stacked single then combined, with a hover readout and a table view. Plain HTML bars, so
// text keeps its size at any width.
export function DailyBets({rows}:{rows:DailyRow[]}){
  const [hover,setHover]=useState<number|null>(null);
  const top=Math.max(1,...rows.map(r=>r.bets));
  const ticks=[top,Math.round(top/2),0].filter((v,i,a)=>a.indexOf(v)===i);
  const active=hover===null?null:rows[hover];
  return <figure className="metrics-chart">
    <figcaption><strong>Bets per day</strong><span className="metrics-legend"><i className="swatch swatch-single"/>Single answer<i className="swatch swatch-combined"/>Combined</span></figcaption>
    <div className="metrics-chart-plot" role="img" aria-label="Bets per day over the last 14 days, split into single and combined" onMouseLeave={()=>setHover(null)}>
      <div className="metrics-yaxis" aria-hidden="true">{ticks.map(v=><span key={v} style={{bottom:`${v*100/top}%`}}>{v}</span>)}</div>
      <div className="metrics-bars">
        {ticks.map(v=><i key={v} className="metrics-gridline" style={{bottom:`${v*100/top}%`}} aria-hidden="true"/>)}
        {rows.map((r,i)=><button type="button" key={r.day} className="metrics-day" onMouseEnter={()=>setHover(i)} onFocus={()=>setHover(i)} onBlur={()=>setHover(null)}
          aria-label={`${r.day}: ${r.bets} bets, ${r.singles} single, ${r.combined} combined`}>
          <span className="metrics-stack">
            {r.combined>0&&<span className="metrics-bar-combined" style={{height:`${r.combined*100/top}%`}}/>}
            {r.singles>0&&<span className="metrics-bar-single" style={{height:`${r.singles*100/top}%`}}/>}
          </span>
          <span className="metrics-day-label">{i%2===(rows.length-1)%2?r.day.slice(5):''}</span>
        </button>)}
        {active&&<div className="metrics-tip" role="status" style={{left:`${(hover!+0.5)*100/rows.length}%`}}><strong>{active.day}</strong><span>{active.bets} bets</span><span>{active.singles} single · {active.combined} combined</span><span>{active.firstBets} first-time bettors</span></div>}
      </div>
    </div>
    <details className="disclosure"><summary>Show as table</summary>
      <table className="metrics-table"><thead><tr><th>Day (UTC)</th><th>Sign-ins</th><th>Requests</th><th>Approvals</th><th>First bets</th><th>Bets</th><th>Single</th><th>Combined</th></tr></thead>
        <tbody>{[...rows].reverse().map(r=><tr key={r.day}><td>{r.day}</td><td>{r.signIns}</td><td>{r.requests}</td><td>{r.approvals}</td><td>{r.firstBets}</td><td>{r.bets}</td><td>{r.singles}</td><td>{r.combined}</td></tr>)}</tbody></table>
    </details>
  </figure>;
}
