import type {PilotNamespace,PilotState} from '../pilot';
import EvidenceDisclosure from './EvidenceDisclosure';
import {ArrowUpRight} from 'lucide-react';

export default function ShowcaseSource({state,event,namespace}:{state:PilotState;event:number;namespace:PilotNamespace}){
  const question=state.manifest.publication.draft.events[event],result=state.cases[event];
  const target=new Date(question.observationStartsAt*1000);
  const hasEvidence=/^0x[0-9a-f]{64}$/i.test(result.evidenceHash)&&!/^0x0{64}$/.test(result.evidenceHash);
  return <section className="detail-panel" aria-label="Which Ethereum block">
    <h2>Which Ethereum block?</h2>
    <p>All four Showcase questions use <strong>the first Ethereum mainnet block timestamped at or after:</strong></p>
    <p><time dateTime={target.toISOString()}><strong>{target.toISOString().replace('T',' ').replace('.000Z',' UTC')}</strong></time><br/><small>{target.toLocaleString(undefined,{year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'})} in your timezone</small></p>
    <p>The block immediately before it must have a timestamp earlier than this cutoff. The chosen block must be finalized. This is one block, not an average over the trading round.</p>
    {hasEvidence?<EvidenceDisclosure namespace={namespace} hash={result.evidenceHash} label="View published assertion evidence"/>:<p>No assertion evidence is published at this snapshot. The block number is identified after the cutoff; it cannot be known in advance.</p>}
    <details className="disclosure"><summary>How the block is checked</summary><p>The bot compares the block and its parent using PublicNode and dRPC. Missing, conflicting or unfinalized data is not treated as No.</p><a className="text-link" href={question.source.referenceUrl} target="_blank" rel="noreferrer">Ethereum API documentation <ArrowUpRight aria-hidden="true" strokeWidth={1.75}/></a><p>This link explains the data format. It is not evidence of this market’s result.</p></details>
  </section>;
}
