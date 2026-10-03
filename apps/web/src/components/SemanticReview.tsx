import { useId } from 'react';
import { formatUnits } from 'viem';
import { CircleCheck, ShieldCheck, ShieldQuestion, TriangleAlert } from 'lucide-react';
import { semanticAcknowledgment, type PilotReview } from '../pilot';
import './semantic-review.css';

// Presentation only. Whether a purchase may proceed is decided by semanticReady in Pilot and
// re-checked by validatePurchaseSemantics right before the wallet prompt.
export function SemanticReview({review,phrase,onChange,allowManualOverride=true}:{review:PilotReview;phrase:string;onChange:(value:string)=>void;allowManualOverride?:boolean}) {
  const helpId=useId();
  if(review.requested.action!=='buy')return null;
  const result=review.semanticAssessment;
  // Switched off: say nothing rather than imply the purchase was checked.
  if(result?.mode==='disabled')return null;
  if(!result)return <p role="status" className="semantic-note"><ShieldQuestion aria-hidden="true" strokeWidth={1.75}/>Outcome compatibility will be checked before confirmation.</p>;
  if(result.status!=='collision')return result.coverage==='complete'
    ? <p className="semantic-note"><ShieldCheck aria-hidden="true" strokeWidth={1.75}/>No conflict found in the configured outcome rules.</p>
    : <p className="semantic-note semantic-note-unverified"><ShieldQuestion aria-hidden="true" strokeWidth={1.75}/>These outcomes have not been verified as compatible.</p>;
  const typed=phrase.length>0, matches=phrase===semanticAcknowledgment;
  return <section className="semantic-conflict" aria-label="Outcome conflict">
    <div className="semantic-conflict-head"><TriangleAlert aria-hidden="true" strokeWidth={1.75}/><h3>These outcomes cannot win together</h3></div>
    <p>Under the configured rules, this purchase pays 0 test AUSD when all events resolve Yes or No. The purchase cost is lost in those outcomes, plus network fees.</p>
    {review.quotedCostAtoms&&<p className="semantic-quote">At this quote: spend {formatUnits(BigInt(review.quotedCostAtoms),6)}, receive 0, lose {formatUnits(BigInt(review.quotedCostAtoms),6)} test AUSD before fees. The final purchase cost can change within your displayed spending limit.</p>}
    <p className="semantic-void">VOID settlement is different. Its maximum payout for this quantity is {formatUnits(BigInt(result.maximumVoidPayoutAtoms??'0'),6)} test AUSD under the existing contract rules. This is not a prediction of a VOID result.</p>
    {!allowManualOverride ? <p role="alert">This agent purchase is blocked. No transaction was sent. Refresh the review after changing the proposal or when the outcome rules have been corrected. Agent approvals do not offer an override.</p> : <div className="semantic-ack">
      <p>Automated purchases are blocked. To proceed manually, type the following acknowledgment.</p>
      <label className="semantic-ack-field">{semanticAcknowledgment}<input autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
        aria-describedby={helpId} aria-invalid={typed&&!matches?true:undefined} value={phrase} onChange={e=>onChange(e.target.value)}/></label>
      <p id={helpId} className={`semantic-ack-state${matches?' is-match':''}`} role="status">{matches
        ?<><CircleCheck aria-hidden="true" strokeWidth={1.75}/>Acknowledgment matches. You can now confirm in your wallet.</>
        :typed?'Type the sentence exactly as shown, including capital letters.':'The confirm button stays off until the sentence matches.'}</p>
    </div>}
  </section>;
}
