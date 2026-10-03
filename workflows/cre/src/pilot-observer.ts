import { z } from 'zod';
import { encodeFunctionData, parseAbi } from 'viem';
import { eventDraftSchema, prepareEventDraft } from './event-draft';
import { observeRelease, releaseEndpoint, releaseTargetForEvent, MAX_RELEASE_BYTES } from './github-release';

const addr=z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(v=>v.toLowerCase());
const hash=z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(v=>v.toLowerCase());
export const pilotObserverSchema=z.object({schema:z.literal('flurbo.pilot-observer.v1'),draft:eventDraftSchema,pool:addr,resolver:addr,rulesHash:hash}).strict();
export type ObserverConfig=z.infer<typeof pilotObserverSchema>;
const triggerSchema=z.object({eventId:z.string(),blockNumber:z.string().regex(/^[1-9][0-9]{0,15}$/),blockHash:hash}).strict();
const abi=parseAbi(['function settlementRulesHash() view returns (bytes32)','function draftHash() view returns (bytes32)','function pool() view returns (address)']);
type Http=(request:{url:string;method:'GET'|'POST';body?:string;headers:Record<string,string>})=>{status:number;body:string};

/** Read-only orchestration. No private key, assertion bond, final outcome or on-chain write. */
export function collectPilotEvidence(rawConfig:unknown,rawTrigger:unknown,now:number,http:Http) {
  const c=pilotObserverSchema.parse(rawConfig),trigger=triggerSchema.parse(rawTrigger);
  const draft=prepareEventDraft(c.draft,now),{target}=releaseTargetForEvent(c.draft,trigger.eventId);
  const tag='0x'+BigInt(trigger.blockNumber).toString(16);
  const requests=[{jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]},
    {jsonrpc:'2.0',id:2,method:'eth_getBlockByNumber',params:[tag,false]},
    {jsonrpc:'2.0',id:3,method:'eth_call',params:[{to:c.pool,data:encodeFunctionData({abi,functionName:'settlementRulesHash'})},tag]},
    {jsonrpc:'2.0',id:4,method:'eth_call',params:[{to:c.resolver,data:encodeFunctionData({abi,functionName:'draftHash'})},tag]},
    {jsonrpc:'2.0',id:5,method:'eth_call',params:[{to:c.resolver,data:encodeFunctionData({abi,functionName:'pool'})},tag]}];
  const response=http({url:'https://testnet-rpc.monad.xyz',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(requests)});
  if(response.status!==200||response.body.length>MAX_RELEASE_BYTES)throw new Error('Monad observation read unavailable');
  const rows=JSON.parse(response.body);
  if(!Array.isArray(rows)||rows.length!==5||new Set(rows.map(r=>r.id)).size!==5)throw new Error('Invalid Monad RPC batch');
  const value=(id:number)=>{const row=rows.find(r=>r.id===id);if(!row||row.error||row.jsonrpc!=='2.0')throw new Error('Monad RPC read rejected');return row.result;};
  const block=value(2);
  if(BigInt(value(1))!==10143n || block?.number!==tag || block?.hash?.toLowerCase()!==trigger.blockHash
    || now-Number(BigInt(block.timestamp))>180 || now-Number(BigInt(block.timestamp)) < -15
    || value(3).toLowerCase()!==c.rulesHash || value(4).toLowerCase()!==draft.draftHash
    || value(5).toLowerCase()!=='0x'+c.pool.slice(2).padStart(64,'0'))throw new Error('Unverified or stale pilot binding');
  const source=http({url:releaseEndpoint(target),method:'GET',headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'Flurbo-CRE-testnet-evidence'}});
  const observation=observeRelease(c.draft,trigger.eventId,source.status,source.body,now);
  return {schema:'flurbo.pilot-cre-evidence.v1',pool:c.pool,resolver:c.resolver,rulesHash:c.rulesHash,
    snapshot:{number:trigger.blockNumber,hash:trigger.blockHash,timestamp:Number(BigInt(block.timestamp))},observation,
    sourcePayload:observation.status==='candidate'?source.body:null,
    notice:'CRE observation only. This output is not a final outcome or proof of authenticated on-chain delivery. Publish evidence and separately review a bonded assertion; challenge and voting remain mandatory.'};
}
