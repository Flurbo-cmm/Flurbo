import {useEffect,useRef,useState} from 'react';
import {claimScenarios, type ClaimRule} from '../../shared/claims.mjs';
import {combinationFits} from '../../shared/pilot.mjs';
import {pilotRequest,type PilotNamespace,type PilotState} from '../pilot';
import {marketQuestion} from '../showcase-copy';
import {Check} from 'lucide-react';
import SegmentedControl from '../components/ui/SegmentedControl';
import './combination-builder.css';

const rules: {value:ClaimRule;label:string;detail:string}[]=[
  {value:'AND',label:'All (AND)',detail:'Every selected answer is correct'},
  {value:'OR',label:'At least one (OR)',detail:'One or more answers are correct, including all'},
  {value:'EXACTLY_ONE',label:'Exactly one',detail:'Exactly one answer is correct'},
  {value:'AT_LEAST_TWO',label:'At least two',detail:'Two or more answers are correct'},
];
export const ruleDescription=(rule:ClaimRule)=>rules.find(r=>r.value===rule)!.detail;

export default function CombinationBuilder({state,base,legs,answers,rule,scope,mask,disabled,onLegs,onAnswer,onRule,namespace}:{
  state:PilotState|null;base:number;legs:number[];answers:Record<number,boolean>;rule:ClaimRule;scope:number;mask:string;disabled:boolean;
  onLegs(legs:number[]):void;onAnswer(event:number,yes:boolean):void;onRule(rule:ClaimRule):void;namespace:PilotNamespace;
}){
  const [open,setOpen]=useState(legs.length>1);
  if(!state)return null;
  const events=state.manifest.publication.draft.events;
  // The pool can only price combinations that keep each question linked to at most two others, counting every
  // combination already bought here. Unknown pool state (older API) leaves every question selectable.
  const selected=legs.reduce((s,i)=>s|1<<i,0);
  const fits=(next:number)=>!state.eliminationOrder||combinationFits(events.length,state.eliminationOrder,state.factorScopes??[],next);
  const currentFits=legs.length<2||fits(selected);
  return <section className="combination-builder" aria-label="Combined prediction builder">
    <button className="combination-toggle" type="button" aria-expanded={open} onClick={()=>setOpen(!open)}>
      <span>{legs.length>1?'Combined prediction':'Combine with another prediction'}</span><span className="combination-toggle-meta">{open?'Close':legs.length>1?`${legs.length} answers`:'Explore'}</span>
    </button>
    {open&&<div className="combination-body">
      <p className="market-caption">Choose up to three questions from this shared pool. The current question stays first; others keep their order.</p>
      <div className="combination-legs">{events.map((e,i)=>{const blocked=!legs.includes(i)&&legs.length<3&&!fits(selected|1<<i);return <div className={'combination-leg'+(legs.includes(i)?' selected':'')+(blocked?' unavailable':'')} key={e.id}>
        <label className="check-row"><input type="checkbox" checked={legs.includes(i)} disabled={disabled||i===base||!legs.includes(i)&&legs.length>=3||blocked}
          onChange={()=>onLegs(legs.includes(i)?legs.filter(v=>v!==i):[...legs,i].sort((a,b)=>a-b))}/><span>{marketQuestion(e)}{i===base&&<small>Current question</small>}{blocked&&<small>Not available with this selection: this pool cannot price that combination</small>}</span></label>
        {legs.includes(i)&&<SegmentedControl className="combination-answer" label={marketQuestion(e)+' answer'} hideLabel value={(answers[i]??true)?'yes':'no'}
          options={[{value:'yes',label:'Yes'},{value:'no',label:'No'}]} onChange={value=>onAnswer(i,value==='yes')} disabled={disabled}/>}
      </div>;})}</div>
      {!currentFits&&<p className="field-help" role="status">This pool cannot accept this combination any more: combinations already bought here link these questions as far as it can price. Remove a question or choose another.</p>}
      {events.some((_,i)=>!legs.includes(i)&&legs.length<3&&!fits(selected|1<<i))&&<p className="field-help">Greyed questions cannot be added here. Each pool prices combined predictions together, and every combination already bought limits which new ones it can accept. <a href="/docs#combinations">How combinations work</a></p>}
      {legs.length>=3&&<p className="field-help">Three questions is the most a combined prediction can hold.</p>}
      {legs.length>1&&<>
        <fieldset className="combination-rules" disabled={disabled}><legend>I win if...</legend>
          {rules.map(r=>{const needsThree=r.value==='AT_LEAST_TWO'&&legs.length<3;return <label key={r.value} className={(rule===r.value?'selected':'')+(needsThree?' unavailable':'')} title={needsThree?'Needs three questions. With two, it is the same as All (AND).':undefined}><input type="radio" name={'claim-rule-'+namespace} value={r.value} checked={rule===r.value} disabled={needsThree} onChange={()=>onRule(r.value)}/><span><strong>{r.label}</strong><small>{needsThree?'Needs three questions':r.detail}</small></span></label>;})}
        </fieldset>
        {legs.length===2&&rule==='AT_LEAST_TWO'&&<p className="field-help">With two questions, at least two means both, the same as All (AND).</p>}
        <details className="combination-scenarios" open><summary>See winning outcomes</summary>
          <p>Each winning share pays 1 test AUSD, even if several answers match. VOID can produce a fractional payout under the market rules.</p>
          <div className="combination-table"><table><caption>Resolved answers and payout per share</caption><thead><tr>{legs.map(event=><th key={event} scope="col">{marketQuestion(events[event])}</th>)}<th scope="col">Payout</th></tr></thead><tbody>
            {claimScenarios(scope,mask,events.length).map(s=><tr key={s.state} className={s.wins?'wins':''}>{s.answers.map(a=><td key={a.event}>{a.yes?'Yes':'No'}</td>)}<td>{s.wins?<><Check aria-hidden="true" strokeWidth={2.25}/>1 AUSD</>:'0 AUSD'}</td></tr>)}
          </tbody></table></div>
          <ol>{legs.map(event=><li key={event}>{marketQuestion(events[event])}</li>)}</ol>
        </details>
        <details className="disclosure"><summary>Compare how the market connects these answers</summary><ClaimComparison key={`${scope}:${mask}`} namespace={namespace} manifest={state.manifest} scope={scope} mask={mask}/></details>
      </>}
    </div>}
    {legs.length>1&&<div className="combination-summary"><strong>I win if {ruleDescription(rule).toLowerCase()}.</strong><ul>{legs.map(event=><li key={event}><span>{marketQuestion(events[event])}</span><b>{(answers[event]??true)?'Yes':'No'}</b></li>)}</ul></div>}
  </section>;
}

type Analysis={schema:string;model:string;chainId:number;pool:string;rulesHash:string;scope:number;mask:string;snapshot:PilotState['snapshot'];expiresAt:number;stateDigest:string;unit:string;closed:boolean;values:{market:number|null;independent:number|null;difference:number|null}};
function ClaimComparison({namespace,manifest,scope,mask}:{namespace:PilotNamespace;manifest:PilotState['manifest'];scope:number;mask:string}){
  const [result,setResult]=useState<Analysis|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[clock,setClock]=useState(Date.now());
  const request=useRef<AbortController|null>(null);
  useEffect(()=>{const timer=setInterval(()=>setClock(Date.now()),1000);return()=>{clearInterval(timer);request.current?.abort();};},[]);
  async function compare(){
    request.current?.abort();const controller=new AbortController();request.current=controller;setBusy(true);setResult(null);setError('');
    try{
      const data=await pilotRequest<Analysis>('claim-analytics',{scope,mask},namespace,controller.signal);
      if(controller.signal.aborted)return;
      if(data.schema!=='flurbo.claim-analytics.v1'||data.model!=='bounded-lmsr-enumeration-v1'||data.chainId!==10143||data.pool!==manifest.pool||data.rulesHash!==manifest.rulesHash||data.scope!==scope||data.mask!==mask||data.unit!=='tenths_of_percentage_point'
        ||typeof data.closed!=='boolean'||!Number.isSafeInteger(data.snapshot?.timestamp)||!/^\d+$/.test(data.snapshot.blockNumber)||!/^0x[0-9a-f]{64}$/.test(data.snapshot.blockHash)||data.expiresAt!==data.snapshot.timestamp+60||! /^[0-9a-f]{64}$/.test(data.stateDigest)
        ||!data.values||(['market','independent','difference'] as const).some(k=>data.values[k]!==null&&(!Number.isInteger(data.values[k])||data.values[k]!<(k==='difference'?-1000:0)||data.values[k]!>1000)))throw Error('Invalid comparison');
      setResult(data);setClock(Date.now());
    }catch{if(!controller.signal.aborted)setError('Comparison unavailable. You can still request a trade quote.');}
    finally{if(request.current===controller&&!controller.signal.aborted)setBusy(false);}
  }
  const fresh=result&&clock/1000<result.expiresAt&&clock/1000>=result.snapshot.timestamp-15;
  const format=(v:number|null)=>v===null?'Unavailable':(v/10).toFixed(1)+'%';
  return <div className="claim-comparison">
    <button type="button" className="btn btn-secondary" disabled={busy} onClick={()=>void compare()}>{busy?'Reading pool...':result?'Refresh comparison':'Compare with independence'}</button>
    {error&&<p role="status">{error}</p>}
    {result&&!fresh&&<p role="status">Comparison expired. Refresh to see current values.</p>}
    {fresh&&<><div className="claim-comparison-values"><div><span>Shared market</span><strong>{format(result.values.market)}</strong></div><div><span>If independent</span><strong>{format(result.values.independent)}</strong></div></div>
      <p>Difference: <strong>{result.values.difference===null?'Unavailable':`${result.values.difference>0?'+':''}${(result.values.difference/10).toFixed(1)} percentage points`}</strong></p>
      <p className="market-caption">{result.closed?'Trading is closed. ':''}Model-implied chance of this exact claim, using one snapshot. The baseline assumes the selected events are independent. Association does not establish causation or a profitable trade.</p>
      <p className="market-caption">Block {result.snapshot.blockNumber}. Rounded to 0.1 percentage point; uncertain values are withheld. Your purchase cost below includes trade-size impact and may use a newer snapshot.</p></>}
  </div>;
}
