import type {PilotManifest} from '../shared/pilot.mjs';
import {thesisCandidates,type ThesisCandidate,type ThesisInput} from '../shared/thesis.mjs';
import type {PilotState} from './pilot';

export type ThesisRow=ThesisCandidate&{probability:number|null;costAtoms:string|null;maxSpendAtoms:string|null;reason:string|null};
export type ThesisSnapshot={schema:string;chainId:number;pool:string;rulesHash:string;eventIds:string[];input:ThesisInput;
  snapshot:PilotState['snapshot'];expiresAt:number;stateDigest:string;closed:boolean;resolved:boolean;unit:string;
  pair:{values:{a:number|null;b:number|null;joint:number|null;givenYes:number|null;givenNo:number|null;independent:number|null;difference:number|null};reasons:Record<string,string>}|null;
  scenarios:(number|null)[]|null;candidates:ThesisRow[];maxTradeQuantityAtoms:string};
const probability=(n:unknown)=>n===null||Number.isInteger(n)&&Number(n)>=0&&Number(n)<=1000;
const atoms=(n:unknown)=>typeof n==='string'&&/^(0|[1-9][0-9]{0,24})$/.test(n);
export function validateThesisSnapshot(value:ThesisSnapshot,manifest:PilotManifest,input:ThesisInput,now=Date.now()/1000){
  const events=manifest.publication.draft.events,expected=thesisCandidates(events.length,input.a,input.b,input.yesA,input.yesB);
  if(value.schema!=='flurbo.thesis.v1'||value.chainId!==10143||value.pool!==manifest.pool||value.rulesHash!==manifest.rulesHash
    ||value.unit!=='tenths_of_percentage_point'||typeof value.closed!=='boolean'||typeof value.resolved!=='boolean'
    ||value.resolved&&!value.closed||! /^[0-9a-f]{64}$/.test(value.stateDigest)
    ||value.eventIds?.join(',')!==[events[input.a].id,events[input.b].id].join(',')
    ||Object.keys(input).some(k=>value.input?.[k as keyof ThesisInput]!==input[k as keyof ThesisInput])
    ||!/^0x[0-9a-f]{64}$/.test(value.snapshot?.blockHash)||!/^\d+$/.test(value.snapshot?.blockNumber)
    ||!Number.isSafeInteger(value.snapshot.timestamp)||value.expiresAt!==value.snapshot.timestamp+60||now>=value.expiresAt||now<value.snapshot.timestamp-15
    ||!value.closed&&now>=manifest.publication.draft.closesAt
    ||!atoms(value.maxTradeQuantityAtoms)||!Array.isArray(value.candidates)||value.candidates.length!==expected.length)throw Error('The comparison changed or expired. Refresh it before continuing.');
  for(let i=0;i<expected.length;i++){
    const row=value.candidates[i],want=expected[i];
    if(row.id!==want.id||row.scope!==want.scope||row.mask!==want.mask||row.rule!==want.rule||JSON.stringify(row.legs)!==JSON.stringify(want.legs)||!probability(row.probability)
      ||row.costAtoms!==null&&(!atoms(row.costAtoms)||BigInt(row.costAtoms)<=0n||BigInt(row.costAtoms)>BigInt(input.quantity)
        ||row.maxSpendAtoms!==((BigInt(row.costAtoms)*10050n+9999n)/10000n).toString())
      ||row.costAtoms===null&&row.maxSpendAtoms!==null||value.closed&&row.costAtoms!==null)throw Error('Invalid comparison quote. Refresh it before continuing.');
  }
  if(value.scenarios!==null&&(!Array.isArray(value.scenarios)||value.scenarios.length!==4||!value.scenarios.every(probability)))throw Error('Invalid scenario probabilities.');
  if(value.pair&&!(['a','b','joint','givenYes','givenNo','independent'] as const).every(k=>probability(value.pair!.values[k])))throw Error('Invalid pool probabilities.');
  return value;
}
export const poolPercent=(n:number|null|undefined)=>n==null?'Unavailable':`${(n/10).toFixed(1)}%`;
export const beliefPercent=(n:bigint)=>`${(Number(n)/1_000_000).toFixed(1)}%`;
