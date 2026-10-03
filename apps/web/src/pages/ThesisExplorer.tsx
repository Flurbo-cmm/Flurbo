import {Fragment,useEffect,useRef,useState} from 'react';
import {Link,useLocation} from 'wouter';
import {formatUnits} from 'viem';
import {useAuth} from '../auth/context';
import {pilotRequest,type PilotNamespace,type PilotState} from '../pilot';
import {marketHref} from '../market-detail';
import {marketQuestion} from '../showcase-copy';
import {saveCheckout} from '../checkout';
import {percentageBps,thesisCandidates,thesisDistribution,thesisProbability,thesisPayout,thesisQuantity,THESIS_DENOMINATOR,type ThesisInput} from '../../shared/thesis.mjs';
import {validateThesisSnapshot,poolPercent,beliefPercent,type ThesisSnapshot,type ThesisRow} from '../thesis';
import {ArrowLeft} from 'lucide-react';
import PageHeader from '../components/PageHeader';
import Select from '../components/ui/Select';
import SegmentedControl from '../components/ui/SegmentedControl';
import {useLoadGate} from '../loading/gates';
import {shares} from '../format';
import './thesis.css';

const names={SINGLE:'Individual',AND:'Both answers (AND)',OR:'At least one (OR)',EXACTLY_ONE:'Exactly one'};
const descriptions={SINGLE:'Pays when B matches your selected answer.',AND:'Pays only when both selected answers happen.',OR:'Pays when either selected answer happens, including both.',EXACTLY_ONE:'Pays when one selected answer happens, but not both.'};
const downside={SINGLE:'This position pays only when B matches your selected answer. A does not affect its binary payout.',AND:'An AND position pays zero if either selected answer fails. It does not refund you when the condition fails.',OR:'An OR position pays if either selected answer matches, including when both match. It pays once per share and loses if neither matches.',EXACTLY_ONE:'This position pays when exactly one selected answer matches. It loses if both match or neither matches.'};
const cash=(n:bigint|string)=>formatUnits(BigInt(n),6);
const net=(n:bigint)=>`${n>0n?'+':''}${cash(n)}`;
function gap(bps:number|null,pool:number|null|undefined){if(bps===null||pool==null)return '';const difference=(bps-pool*10)/100;return `${difference>0?'+':''}${Number(difference.toFixed(2))} percentage points vs pool`;}
const outcomes:[boolean|null,boolean|null][]=[[false,false],[true,false],[false,true],[true,true],[null,false],[null,true],[false,null],[true,null],[null,null]];
export default function ThesisExplorer({namespace,event}:{namespace:PilotNamespace;event:number}){
  const {state:auth}=useAuth(),[,navigate]=useLocation();
  const [state,setState]=useState<PilotState|null>(null),[loadError,setLoadError]=useState(''),[retry,setRetry]=useState(0);
  const [a,setA]=useState(event),[b,setB]=useState(event===0?1:0),[yesA,setYesA]=useState(true),[yesB,setYesB]=useState(true);
  const [forecast,setForecast]=useState(['','','']),[origin,setOrigin]=useState('Your estimates'),[note,setNote]=useState('');
  const [quantity,setQuantity]=useState('1'),[data,setData]=useState<ThesisSnapshot|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [selected,setSelected]=useState<ThesisRow['id']>('AND'),[now,setNow]=useState(Date.now()/1000);
  const controller=useRef<AbortController|null>(null),generation=useRef(0),baselineTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  useEffect(()=>{const c=new AbortController();setLoadError('');void pilotRequest<PilotState>('status',undefined,namespace,c.signal).then(s=>{if(!c.signal.aborted)setState(s);}).catch(()=>{if(!c.signal.aborted)setLoadError('Market data could not be loaded. Try again.');});return()=>c.abort();},[namespace,retry]);
  useEffect(()=>{const t=setInterval(()=>setNow(Date.now()/1000),1000);return()=>{clearInterval(t);controller.current?.abort();};},[]);
  useEffect(()=>{const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};if(forecast.some(Boolean)||note)window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[forecast,note]);
  function invalidate(){generation.current++;controller.current?.abort();setData(null);setError('');setBusy(false);}
  function choosePair(first:number,second:number){invalidate();setA(first);setB(second);setForecast(['','','']);setOrigin('Your estimates');setNote('');}
  const manifest=state?.manifest,events=manifest?.publication.draft.events;
  const q=(index:number)=>events?.[index]?marketQuestion(events[index]):'';
  const amount=thesisQuantity(quantity),bps=forecast.map(percentageBps);
  const distribution=bps.every(p=>p!==null)?thesisDistribution(bps[0]!,bps[1]!,bps[2]!):null;
  const fresh=!!data&&now<data.expiresAt,closed=!!data?.closed||!!state?.resolved||!!manifest&&now>=manifest.publication.draft.closesAt;
  // Payoff rules are local definitions; only market estimates and executable quotes need a response.
  const candidates:ThesisRow[]=data?.candidates??(events?.[a]&&events?.[b]&&a!==b?thesisCandidates(events.length,a,b,yesA,yesB).map(c=>({...c,probability:null,costAtoms:null,maxSpendAtoms:null,reason:null})):[]);
  const row=candidates.find(c=>c.id===selected),cost=row?.costAtoms!=null?BigInt(row.costAtoms):null;
  async function compare(){
    if(baselineTimer.current!==null){clearTimeout(baselineTimer.current);baselineTimer.current=null;}
    if(!manifest||amount===null||a===b)return;
    controller.current?.abort();const c=new AbortController();controller.current=c;const version=++generation.current;
    const input:ThesisInput={a,b,yesA,yesB,quantity:String(amount)};setBusy(true);setError('');setData(null);
    try{const result=await pilotRequest<ThesisSnapshot>('thesis',input,namespace,c.signal);validateThesisSnapshot(result,manifest,input);if(version===generation.current&&!c.signal.aborted){setData(result);setNow(Date.now()/1000);}}
    catch(e){if(!c.signal.aborted&&version===generation.current)setError(e instanceof Error?e.message:'Comparison unavailable. Try again.');}
    finally{if(version===generation.current)setBusy(false);}
  }
  // Load one baseline per pair/answer/size. Beliefs and notes never leave the page.
  useEffect(()=>{if(!manifest)return;baselineTimer.current=setTimeout(()=>void compare(),400);return()=>{if(baselineTimer.current!==null)clearTimeout(baselineTimer.current);};},[manifest?.pool,a,b,yesA,yesB,quantity]);
  useLoadGate('thesis',{pending:!state&&!loadError,label:'Loading your thesis'});
  function usePool(){
    const p=data?.pair?.values;
    if(!fresh||!p||p.b===null||p.givenYes===null||p.givenNo===null)return;
    setForecast([p.b,p.givenYes,p.givenNo].map(n=>(n/10).toFixed(1)));setOrigin('Started from rounded pool estimates');
  }
  function review(){
    if(!manifest||!data||!row||!fresh||closed||cost===null||!distribution||!auth.address||amount===null)return;
    try{
      validateThesisSnapshot(data,manifest,{a,b,yesA,yesB,quantity:String(amount)});
      const anchor=row.id==='SINGLE'?b:a,answer=anchor===a?yesA:yesB;
      saveCheckout(namespace,auth.address,{event:anchor,yes:answer,legs:row.legs.map(l=>l.event),answers:Object.fromEntries(row.legs.map(l=>[l.event,l.yes])),rule:row.rule,quantity,side:'buy',walletKind:'browser',binding:{pool:manifest.pool,rulesHash:manifest.rulesHash}});
      navigate(marketHref(namespace,anchor,answer));
    }catch(e){setError(e instanceof Error?e.message:'Could not prepare your prediction.');}
  }
  const questionOptions=(events??[]).map((question,i)=>({value:String(i),label:marketQuestion(question),text:marketQuestion(question)}));
  return <main id="main" tabIndex={-1} className="page markets-page thesis-page" aria-busy={!state&&!loadError}>
    <PageHeader back={<Link className="link-back" href={marketHref(namespace,event)}><ArrowLeft aria-hidden="true" strokeWidth={1.75}/>Back to market</Link>}
      title="Build your thesis." lead="Put your view into numbers. See what the pool thinks, and what each outcome would mean for you."/>
    {loadError&&<div role="alert" className="state-inline error"><p>{loadError}</p><button className="btn btn-secondary btn-sm" onClick={()=>setRetry(n=>n+1)}>Retry</button></div>}
    {!state&&!loadError&&<><p role="status" className="sr-only">Loading questions...</p><div className="thesis-layout" aria-hidden="true"><span className="skeleton" style={{height:480}}/><span className="skeleton" style={{height:480}}/></div></>}
    {events&&(!events[a]||!events[b])&&<p role="alert" className="state-inline error">This explorer needs two questions in the same pool.</p>}
    {events?.[a]&&events?.[b]&&<>
      <div className="thesis-layout">
        <section className="thesis-panel thesis-view" aria-labelledby="thesis-view-title">
          <div className="thesis-section-head"><h2 id="thesis-view-title">Your view</h2><span className="chip">{closed?'Exploration only':'Same shared pool'}</span></div>
          <div className="thesis-pair">{([['A',a],['B',b]] as const).map(([label,index])=><Select key={label} label={`Question ${label}`} value={String(index)}
            options={questionOptions.map(o=>({...o,disabled:Number(o.value)===(label==='A'?b:a)}))}
            onChange={value=>label==='A'?choosePair(Number(value),b):choosePair(a,Number(value))}/>)}</div>
          <p className="thesis-caption">A is your assumption. B is the prediction you want to explore. Changing questions clears your estimates.</p>
          <div className="thesis-forecast-head"><h3>What changes your mind?</h3><button className="btn btn-secondary btn-sm" disabled={!fresh||!data?.pair||data.pair.values.givenYes===null||data.pair.values.givenNo===null} onClick={usePool}>Start from pool estimates</button></div>
          <div className="thesis-forecasts">{['Chance A is Yes','Chance B is Yes, if A is Yes','Chance B is Yes, if A is No'].map((label,i)=>{const key=i===0?'b':i===1?'givenYes':'givenNo';return <div className="thesis-forecast" key={label}>
            <label htmlFor={`forecast-${i}`}>{label}</label><small className="thesis-question">{i===0?q(a):q(b)}</small>
            <div className="thesis-forecast-row"><div className="thesis-percent-input"><input id={`forecast-${i}`} aria-label={label} inputMode="decimal" value={forecast[i]} placeholder="Your estimate" maxLength={6} aria-invalid={forecast[i]!==''&&bps[i]===null} onChange={e=>{setForecast(old=>old.map((v,j)=>j===i?e.target.value:v));setOrigin('Your estimates');}}/><span>%</span></div>
              <span className="thesis-pool">{data?<>Pool {poolPercent(data.pair?.values[key])}{!fresh?' (expired)':''}</>:busy?<span className="skeleton skeleton-line" style={{width:64}}/>:'Pool not loaded'}</span></div>
            {fresh&&gap(bps[i],data?.pair?.values[key])&&<small className="thesis-gap">{gap(bps[i],data?.pair?.values[key])}</small>}
            {forecast[i]!==''&&bps[i]===null&&<small role="alert" className="field-error">Use 0 to 100, with up to two decimal places.</small>}
          </div>;})}</div>
          <p className="thesis-caption">{origin}. Enter all three to compare complete forecasts. Your view is not a prediction guarantee.</p>
          {!data&&<p className="thesis-caption">{error?'Pool estimates are unavailable. Retry Compare with pool below.':'Loading a pool baseline for these questions. You can enter your own estimates while it loads.'}</p>}
          {(bps[0]===0||bps[0]===10000)&&<p className="thesis-caption">Your forecast assigns zero weight to A being {bps[0]===0?'Yes':'No'}. The corresponding conditional estimate cannot affect the result.</p>}
          {distribution&&<div className="thesis-distribution" role="group" aria-label="Your four possible outcomes"><span className="thesis-axis thesis-axis-corner" aria-hidden="true"/><span className="thesis-axis" aria-hidden="true">A No</span><span className="thesis-axis" aria-hidden="true">A Yes</span>
            {['Neither is Yes','A Yes, B No','A No, B Yes','Both are Yes'].map((label,i)=><Fragment key={label}>{i%2===0&&<span className="thesis-axis thesis-axis-row" aria-hidden="true">{i===0?'B No':'B Yes'}</span>}<div className="thesis-cell"><span>{label}</span><strong>{beliefPercent(distribution[i])}</strong><small>Pool {poolPercent(data?.scenarios?.[i])}</small></div></Fragment>)}
          </div>}
          <details className="thesis-note disclosure"><summary>Add a reasoning note</summary><div className="field"><label htmlFor="thesis-note">Why do you expect this connection?</label><textarea id="thesis-note" maxLength={2000} rows={3} value={note} onChange={e=>setNote(e.target.value)} placeholder="What would support or invalidate your view?"/><p className="thesis-caption">Your note and estimates stay in this page's memory. They are not sent to the server or saved when you leave.</p></div></details>
        </section>
        <div className="thesis-right">
          <section className="thesis-panel" aria-labelledby="thesis-compare-title"><div className="thesis-section-head"><h2 id="thesis-compare-title">Same view. Different payoffs.</h2></div>
            <div className="thesis-controls">
              <SegmentedControl label="A's selected answer" value={yesA?'true':'false'} options={[{value:'true',label:'Yes'},{value:'false',label:'No'}]} onChange={v=>{invalidate();setYesA(v==='true');}} block/>
              <SegmentedControl label="B's selected answer" value={yesB?'true':'false'} options={[{value:'true',label:'Yes'},{value:'false',label:'No'}]} onChange={v=>{invalidate();setYesB(v==='true');}} block/>
              <div className="field"><label htmlFor="thesis-shares">Shares per option</label><input id="thesis-shares" aria-label="Shares per option" inputMode="decimal" value={quantity} onChange={e=>{invalidate();setQuantity(e.target.value);}}/></div>
              <button className="btn btn-primary" disabled={busy||amount===null} onClick={()=>void compare()}>{busy?'Checking one snapshot...':data?'Refresh comparison':'Compare with pool'}</button>
            </div>
            {busy&&<span className="progress-line" aria-hidden="true"/>}
            {amount===null&&<p role="alert" className="field-error">Enter more than 0 and no more than 100 shares, with up to six decimal places. The pool may have a lower limit.</p>}
            <p className="thesis-caption">Equal share counts, not equal budgets. Each winning share pays 1 test AUSD for a binary result. Quotes include price impact; probabilities do not. Pool probabilities are rounded to 0.1 percentage point.</p>
            {error&&<p role="alert" className="state-inline error">{error}</p>}
            {data&&<p className="thesis-caption" role="status">{closed?'Trading is closed. Pool estimates describe stored pricing state, not final outcomes. Explore without placing a trade.':!fresh?'This comparison has expired. Refresh before reviewing a trade.':`Snapshot at ${new Date(data.snapshot.timestamp*1000).toLocaleTimeString()}. Quotes expire after 60 seconds.`}</p>}
            <p className="thesis-caption">Select a payoff rule below to explore it. Choose Individual, AND, OR or Exactly one. Compare with pool to load prices for all four.</p>
            <div className="thesis-candidates">{candidates.map(r=>{
              const probability=distribution?thesisProbability(distribution,r,events.length,a,b):null;
              const expected=probability!==null&&r.costAtoms!==null&&amount!==null?amount*probability/THESIS_DENOMINATOR-BigInt(r.costAtoms):null;
              return <button type="button" className="thesis-candidate" key={r.id} aria-pressed={selected===r.id} onClick={()=>setSelected(r.id)}><span className="thesis-candidate-answer">{r.id==='SINGLE'?`B ${yesB?'Yes':'No'}`:`A ${yesA?'Yes':'No'} / B ${yesB?'Yes':'No'}`}</span><h3>{names[r.id]}</h3><p>{descriptions[r.id]}</p><dl><div><dt>Your chance</dt><dd>{probability===null?'Enter forecast':beliefPercent(probability)}</dd></div><div><dt>Pool chance</dt><dd>{!data?(busy?'Loading...':'Not loaded'):poolPercent(r.probability)}</dd></div><div><dt>Buy quote</dt><dd>{!data?(busy?'Loading...':'Not loaded'):r.costAtoms===null?'Unavailable':cash(r.costAtoms)+' AUSD'}</dd></div>{expected!==null&&<div><dt>Your expected net</dt><dd>{net(expected)} AUSD</dd></div>}</dl>{r.reason&&<small>{r.reason==='quantity_limit'&&data?`Try ${cash(data.maxTradeQuantityAtoms)} shares or fewer.`:r.reason==='market_closed'?'Trading closed.':'No executable quote for this claim and size.'}</small>}<span className="thesis-choice">{selected===r.id?'Selected':'Explore this payoff'}</span></button>;
            })}</div>
            <p className="thesis-caption">Expected net uses your probabilities and this buy quote. It excludes gas and assumes binary outcomes, not VOID. It is not a recommendation or a forecast of profit.</p>
          </section>
          {row&&amount!==null&&<section className="thesis-panel" aria-labelledby="thesis-downside-title"><div className="thesis-section-head"><h2 id="thesis-downside-title">{names[row.id]}: what pays?</h2><span className="thesis-caption">{shares(quantity)}</span></div><p className="thesis-warning">{downside[row.id]}</p>
            <div className="thesis-table-wrap"><table className="data-table compact"><caption>Binary outcomes for A: {q(a)} and B: {q(b)}</caption><thead><tr><th scope="col">A</th><th scope="col">B</th><th scope="col" className="num">Your chance</th><th scope="col" className="num">Gross payout</th><th scope="col" className="num">Net at quote</th></tr></thead><tbody>{outcomes.slice(0,4).map(([x,y],i)=>{const payout=thesisPayout(row,events.length,a,b,x,y,amount);return <tr key={i} className={payout>0n?'pays':undefined}><td>{x?'Yes':'No'}</td><td>{y?'Yes':'No'}</td><td className="num">{distribution?beliefPercent(distribution[i]):'Not entered'}</td><td className="num">{cash(payout)}</td><td className="num">{cost===null?'Unavailable':net(payout-cost)}</td></tr>;})}</tbody></table></div>
            <details className="thesis-void disclosure"><summary>If an answer becomes VOID</summary><p>VOID averages the binary completions of the unresolved answer under the pool's rules. It is not automatically a refund. Payouts are rounded down to token atoms.</p><div className="thesis-table-wrap"><table className="data-table compact"><caption>VOID outcomes, in test AUSD</caption><thead><tr><th scope="col">A</th><th scope="col">B</th><th scope="col" className="num">Gross payout</th><th scope="col" className="num">Net at quote</th></tr></thead><tbody>{outcomes.slice(4).map(([x,y],i)=>{const payout=thesisPayout(row,events.length,a,b,x,y,amount);return <tr key={i}><td>{x===null?'VOID':x?'Yes':'No'}</td><td>{y===null?'VOID':y?'Yes':'No'}</td><td className="num">{cash(payout)}</td><td className="num">{cost===null?'Unavailable':net(payout-cost)}</td></tr>;})}</tbody></table></div></details>
            <div className="thesis-review"><div><strong>{cost===null?'No current buy quote':`${cash(cost)} test AUSD quoted`}</strong><p className="thesis-caption">{row.maxSpendAtoms!==null?`Maximum spend at 0.5% slippage: ${cash(row.maxSpendAtoms)} test AUSD, plus gas. `:''}The next screen checks a fresh price and uses MetaMask. No trade is submitted here. Estimates and notes are not saved.</p></div><button className="btn btn-primary btn-lg" aria-describedby="thesis-review-help" disabled={!fresh||closed||cost===null||!distribution} onClick={review}>Review this prediction</button></div><p id="thesis-review-help" className="thesis-caption">{closed?'Trading is closed. You can still compare outcomes.':!fresh?'Wait for a current quote, or refresh the comparison.':!distribution?'Enter all three estimates, or choose Start from pool estimates, to review this prediction.':cost===null?'No quote is available for this size. Try fewer shares.':'Ready to review. MetaMask confirmation happens on the next screen.'}</p>
          </section>}
        </div>
      </div>
      <details className="thesis-formulas disclosure"><summary>How these are calculated</summary><p>Your four outcome chances come from your three estimates: P(A and B) = P(A) × P(B if A); P(A and not B) = P(A) × (1 − P(B if A)); P(B and not A) = (1 − P(A)) × P(B if not A); P(neither) is the remainder. Each payoff shape adds the chances of the outcomes where it pays. Pool chances are the model-implied probabilities of the same outcomes from one snapshot, and the buy quote adds the price impact of the chosen size.</p></details>
      <p className="thesis-caption">A conditional relationship does not establish cause and effect. Pool estimates reflect trading state, not independent evidence.</p>
    </>}
  </main>;
}
