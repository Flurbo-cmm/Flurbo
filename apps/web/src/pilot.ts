import { keccak256, type Hex } from 'viem';
import {eligibilityTypedData} from '../shared/holder-challenge.mjs';
import {verifyTypedData} from 'viem';
import { appFetch as fetch } from './platform-fetch.ts';
import { takeEarly } from './prefetch.ts';
import { pilotCall, type PilotManifest } from '../shared/pilot.mjs';
import type { AuthController } from './auth/controller';
import { semanticError } from '../../../packages/sdk/src/semantics.ts';
export const semanticAcknowledgment = 'I understand this has no ordinary winning outcome';
export type SemanticAssessment = { mode:'disabled'|'enforced'; configRevision:string; rulesDigest?:string; status?:string; coverage?:string; notice:string; ordinaryMaximumPayoutAtoms?:string; maximumVoidPayoutAtoms?:string };
export class PurchaseSemanticCollision extends Error {
  readonly assessment: SemanticAssessment;
  constructor(assessment: SemanticAssessment) {
    super('These outcomes cannot win together under the configured rules. Review the payout warning before continuing.');
    this.name = 'PurchaseSemanticCollision';
    this.assessment = assessment;
  }
}

export type Provider={request(input:{method:string;params?:unknown[]}):Promise<unknown>;on?(event:string,fn:()=>void):void;removeListener?(event:string,fn:()=>void):void};
export type PilotState={manifest:PilotManifest;snapshot:{blockNumber:string;blockHash:string;timestamp:number};
  cases:{phase:number;proposal:number;counter:number;result:number;asserter:string;disputer:string;evidenceHash:string;counterEvidenceHash:string;challengeUntil:string;voteUntil:string;assertionDeadline:string;votes:number[];voted:boolean}[];
  delivered:boolean;resolved:boolean;voidMask:number;requiredCollateral:string;poolCash:string;maxTradeQuantityAtoms?:string;
  factorScopes?:number[];eliminationOrder?:number[];
  wallet:null|{address:string;cash:string;credits:string;reviewer:boolean}};
export type HoldingWitness={holder:string;scope:number;mask:string;wrapped:boolean};
export type HolderAuthorization=HoldingWitness&{accountCommitment:Hex;challenger:string;nonce:string;deadline:string};
export type PilotInput={owner:string;action:string;event?:number;outcome?:number;evidenceHash?:string;evidenceURI?:string;scope?:number;mask?:string;quantity?:string;slippageBps?:number;stake?:HoldingWitness;authorization?:HolderAuthorization;signature?:Hex};
export type PilotReview={schema:string;manifest:PilotManifest;snapshot:PilotState['snapshot'];expiresAt:number;action:string;requested:PilotInput;title:string;amountAtoms:string;minimumReceivedAtoms?:string;
  gasLimit:string;gasPrice:string;maximumFeeWei:string;semanticAssessment?:SemanticAssessment|null;impact?:{quoteAtoms:string;oneShareAtoms:string}|null;quotedCostAtoms?:string|null;
  transaction:{from:Hex;to:Hex;data:Hex;value:Hex;chainId:Hex};notice:string};
export type PilotPending={review:PilotReview;nonce:Hex;hash:Hex|null;started:number;login:string};
export const pilotPendingKey='flurbo.pilot.pending.v1';
// Average price per share for this size against one share of the same claim, in basis points
// (worse than one share: above it for a buy, below it for a sale). Null for one share or no quote.
export function priceImpact(review:Pick<PilotReview,'impact'|'requested'|'action'>):{averageAtoms:bigint;bps:number}|null{
  try{
    const quantity=BigInt(review.requested?.quantity??'0'),quote=BigInt(review.impact?.quoteAtoms??'0'),one=BigInt(review.impact?.oneShareAtoms??'0');
    if(quantity<=1_000_000n||quote<=0n||one<=0n||!['buy','sell','approve'].includes(review.action))return null;
    const averageAtoms=quote*1_000_000n/quantity,worse=review.requested.action==='sell'?one-averageAtoms:averageAtoms-one;
    return {averageAtoms,bps:Number(worse*10_000n/one)};
  }catch{return null;}
}
const practiceModes = ['rehearsal','ethereum-activity','deterministic-source-v1'];
export type PilotNamespace='pilot'|`practice-${string}`;
export const isPracticeNamespace=(value:string):value is Exclude<PilotNamespace,'pilot'>=>/^practice-[0-9a-f]{40}$/.test(value);
export const pendingKeyFor=(namespace:PilotNamespace)=>{
  if(namespace!=='pilot'&&!isPracticeNamespace(namespace))throw Error('Invalid collection');
  return namespace==='pilot'?pilotPendingKey:`flurbo.${namespace}.pending.v1`;
};

// The market view and the position card both read a market's status as a page opens, one right after the other.
// A status read that is in flight, or finished less than STATUS_REUSE_MS ago, is shared instead of read again;
// it is never older than that, and reads with a wallet (the trade ticket) are always fresh.
const STATUS_REUSE_MS=2_000;
const sharedStatus=new Map<string,{at:number|null;promise:Promise<unknown>}>();
export async function pilotRequest<T>(path:string,input?:unknown,namespace:PilotNamespace='pilot',signal?:AbortSignal):Promise<T> {
  if(path==='status'&&input===undefined){
    const key=namespace,entry=sharedStatus.get(key);
    if(entry&&(entry.at===null||Date.now()-entry.at<STATUS_REUSE_MS))return structuredClone(await abortable(entry.promise,signal)) as T;
    const shared={at:null as number|null,promise:readPilot('status',undefined,namespace)};
    sharedStatus.set(key,shared);
    shared.promise.then(()=>{shared.at=Date.now();},()=>{if(sharedStatus.get(key)===shared)sharedStatus.delete(key);});
    return structuredClone(await abortable(shared.promise,signal)) as T;
  }
  return readPilot<T>(path,input,namespace,signal);
}
// A shared read keeps going for the others when one caller aborts; that caller still stops waiting.
function abortable<T>(promise:Promise<T>,signal?:AbortSignal):Promise<T>{
  if(!signal)return promise;
  if(signal.aborted)return Promise.reject(signal.reason);
  return new Promise((resolve,reject)=>{const stop=()=>reject(signal.reason);signal.addEventListener('abort',stop,{once:true});
    promise.then(v=>{signal.removeEventListener('abort',stop);resolve(v);},e=>{signal.removeEventListener('abort',stop);reject(e);});});
}
async function readPilot<T>(path:string,input?:unknown,namespace:PilotNamespace='pilot',signal?:AbortSignal):Promise<T> {
  if(namespace!=='pilot'&&!isPracticeNamespace(namespace))throw Error('Invalid collection');
  const response=(input===undefined?await takeEarly('/api/'+namespace+'/'+path):null)??await fetch('/api/'+namespace+'/'+path,{method:input===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',
    headers:input===undefined?{}:{'Content-Type':'application/json'},body:input===undefined?undefined:JSON.stringify(input),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(60_000)]):AbortSignal.timeout(60_000)});
  const result=await response.json();
  if(!response.ok) {
    if(result.code==='INVITE_REQUIRED'&&typeof window!=='undefined')window.dispatchEvent(new Event('flurbo:access-required'));
    throw new Error(result.error || 'Pilot request failed. Refresh before retrying.');
  }
  if(result.manifest&&namespace.startsWith('practice-')&&(result.manifest.pool!=='0x'+namespace.slice(9)||!practiceModes.includes(result.manifest.publication?.mode)))throw Error('Response belongs to a different collection.');
  return result;
}
async function namespaceRpc(namespace:PilotNamespace,method:string,params:unknown[]=[]){ return (await pilotRequest<{result:unknown}>('rpc',{method,params},namespace)).result; }
const hex=(n:bigint)=>`0x${n.toString(16)}` as Hex;
export function rpcInteger(value:unknown):bigint {
  if(typeof value==='number' && Number.isSafeInteger(value) && value>=0) return BigInt(value);
  if(typeof value==='string' && /^0x[0-9a-f]{1,64}$/i.test(value)) return BigInt(value);
  throw new Error('Wallet returned an invalid integer.');
}

export function pilotMera(controller:AuthController,namespace:PilotNamespace='pilot'):Provider {
  const rpc=(method:string,params:unknown[]=[])=>namespaceRpc(namespace,method,params);
  return {async request({method,params=[]}) {
    const owner=controller.getSnapshot().address;
    if(['eth_accounts','eth_requestAccounts'].includes(method)) return owner?[owner]:[];
    if (!['eth_chainId','eth_getBlockByNumber','eth_getCode','eth_call','eth_estimateGas','eth_gasPrice','eth_getBalance','eth_getTransactionReceipt','eth_getTransactionByHash','eth_getTransactionCount'].includes(method)) throw new Error('Mera is for account access only. Use MetaMask for transactions.');
    return rpc(method,params);
  }};
}

export function validatePilotReview(r:PilotReview,now=Date.now(),tracking=false) {
  if(r.schema!=='flurbo.pilot-review.v1' || r.manifest.status!=='verified_pilot_snapshot' || r.transaction.chainId!=='0x279f'
    || r.transaction.value!=='0x0' || r.transaction.from.toLowerCase()!==r.requested.owner.toLowerCase()
    || !/^0x[0-9a-f]{64}$/i.test(r.snapshot.blockHash) || !Number.isSafeInteger(r.expiresAt) || !Number.isSafeInteger(r.snapshot.timestamp)
    || r.expiresAt-r.snapshot.timestamp!==300 || !tracking && (now/1000>=r.expiresAt || now/1000<r.snapshot.timestamp-15)) throw new Error('Review expired or invalid. Review again.');
  const plan=pilotCall({to:r.transaction.to,data:r.transaction.data,manifest:r.manifest});
  for(const v of [r.gasLimit,r.gasPrice,r.maximumFeeWei])if(typeof v!=='string'||!/^[1-9][0-9]{0,30}$/.test(v))throw new Error('Invalid fee review');
  if(BigInt(r.gasLimit)>15_000_000n||BigInt(r.gasPrice)>500_000_000_000n||BigInt(r.maximumFeeWei)!==BigInt(r.gasLimit)*BigInt(r.gasPrice))throw new Error('Fee exceeds pilot policy');
  if(!plan || plan.name!==r.action) throw new Error('Transaction differs from the displayed action');
  const a=plan.args, wanted=r.requested;
  if(wanted.action==='dispute'&&r.manifest.challengePolicy){
    const e=wanted.authorization;
    if(!e||!wanted.signature||e.challenger.toLowerCase()!==wanted.owner.toLowerCase()||!tracking&&Number(e.deadline)<=now/1000)throw Error('Challenge eligibility expired. Review again.');
    if(plan.name==='dispute'){
      const encoded=a[4] as Record<string,unknown>;
      for(const key of ['accountCommitment','challenger','holder','scope','mask','wrapped','nonce','deadline'] as const)if(String(encoded[key]).toLowerCase()!==String(e[key]).toLowerCase())throw Error('Challenge eligibility changed.');
      if(a[5]!==wanted.signature)throw Error('Challenge signature changed.');
    }
  }
  if(plan.name==='approve') {
    const spender=['buy','sell','redeem'].includes(wanted.action)?r.manifest.pool:r.manifest.resolver;
    if(String(a[0]).toLowerCase()!==spender || String(a[1])!==r.amountAtoms || !['buy','assertOutcome','dispute'].includes(wanted.action)) throw new Error('Unexpected approval');
  } else {
    if(plan.name!==wanted.action) throw new Error('Wrong action');
    if(['assertOutcome','dispute','vote'].includes(plan.name) && (a[0]!==wanted.event || a[1]!==wanted.outcome || String(a[2]).toLowerCase()!==wanted.evidenceHash?.toLowerCase() || a[3]!==wanted.evidenceURI)) throw new Error('Evidence or outcome changed');
    if(plan.name==='finalize' && a[0]!==wanted.event) throw new Error('Wrong event');
    if(['buy','sell','redeem'].includes(plan.name) && (a[0]!==wanted.scope || String(a[1])!==wanted.mask || String(a[2])!==wanted.quantity)) throw new Error('Claim changed');
    if(plan.name==='buy' && String(a[3])!==r.amountAtoms || plan.name==='sell' && r.minimumReceivedAtoms!==undefined && String(a[3])!==r.minimumReceivedAtoms) throw new Error('Displayed trading limit changed');
    if(plan.name==='sell' && !tracking && r.minimumReceivedAtoms===undefined) throw new Error('Minimum proceeds missing. Review again.');
    if(['buy','sell'].includes(plan.name) && (BigInt(String(a[4]))<=BigInt(r.snapshot.timestamp) || BigInt(String(a[4]))>BigInt(r.expiresAt) || BigInt(String(a[4]))>=BigInt(r.manifest.publication.draft.closesAt))) throw new Error('Unexpected trading deadline');
  }
  return plan;
}

export function readPilotPending(namespace:PilotNamespace='pilot'):PilotPending|null {
  const raw=localStorage.getItem(pendingKeyFor(namespace));
  if(!raw) return null;
  if(raw.length>100_000) throw new Error('Saved transaction is invalid. Do not resubmit.');
  const value=JSON.parse(raw) as PilotPending;
  if((practiceModes.includes(value.review.manifest.publication.mode||''))!==isPracticeNamespace(namespace)
    ||namespace.startsWith('practice-')&&value.review.manifest.pool!=='0x'+namespace.slice(9))throw new Error('Saved transaction belongs to a different market');
  validatePilotReview(value.review,Date.now(),true); rpcInteger(value.nonce);
  if(value.hash!==null && !/^0x[0-9a-f]{64}$/i.test(value.hash) || !Number.isFinite(value.started)) throw new Error('Invalid transaction tracking');
  return value;
}

async function walletIdentity(p:Provider,r:PilotReview) {
  if(rpcInteger(await p.request({method:'eth_chainId'}))!==10143n) throw new Error('Select public Monad testnet in your wallet.');
  const accounts=await p.request({method:'eth_accounts'}) as string[];
  if(!Array.isArray(accounts) || accounts[0]?.toLowerCase()!==r.transaction.from.toLowerCase()) throw new Error('Wallet changed. Review again.');
  const anchor=await p.request({method:'eth_getBlockByNumber',params:[hex(BigInt(r.manifest.verifiedBlock)),false]}) as {hash?:string}|null;
  if(anchor?.hash?.toLowerCase()!==r.manifest.verifiedBlockHash) throw new Error('Wallet network does not match this public deployment.');
}

export async function validatePurchaseSemantics(r:PilotReview, namespace:PilotNamespace, acknowledgment?:{rulesDigest:string;phrase:string}) {
  if(r.requested.action!=='buy')return;
  const wanted=r.requested;
  const result=await pilotRequest('validate-trade',{scope:wanted.scope,mask:wanted.mask,quantityAtoms:wanted.quantity},namespace);
  const reason=semanticError(result,{pool:r.manifest.pool,rulesHash:r.manifest.rulesHash,eventCount:r.manifest.publication.draft.events.length,scope:wanted.scope!,mask:wanted.mask!,quantityAtoms:wanted.quantity!},Math.floor(Date.now()/1000),false);
  const checked=result as SemanticAssessment;
  if(reason==='SEMANTIC_COLLISION'){
    if(r.semanticAssessment?.status!=='collision'||!checked.rulesDigest||acknowledgment?.rulesDigest!==checked.rulesDigest||r.semanticAssessment.rulesDigest!==checked.rulesDigest||acknowledgment.phrase!==semanticAcknowledgment)
      throw new PurchaseSemanticCollision(checked);
  }else if(reason)throw Error('The outcome compatibility check is unavailable. Retry before confirming in your wallet.');
  // A mode switch or any configuration change since the review invalidates what the person saw.
  if(r.semanticAssessment&&(r.semanticAssessment.configRevision!==checked.configRevision||r.semanticAssessment.rulesDigest!==checked.rulesDigest))throw Error('The outcome rules changed. Review this purchase again.');
}

export async function submitPilot(p:Provider,r:PilotReview,login:string,save:(value:PilotPending|null)=>void,current:()=>boolean,options:{namespace?:PilotNamespace;acknowledgment?:{rulesDigest:string;phrase:string}}={}) {
  validatePilotReview(r); await walletIdentity(p,r);
  if(r.requested.action==='dispute'&&r.manifest.challengePolicy&&!await verifyTypedData({...eligibilityTypedData(r.manifest.resolver,r.requested,r.requested.authorization),address:r.manifest.challengePolicy.authority as Hex,signature:r.requested.signature!}))throw Error('Invalid challenge eligibility signature.');
  for(const to of [r.manifest.pool,r.manifest.resolver]) {
    const code=await p.request({method:'eth_getCode',params:[to,'latest']}) as Hex;
    if(keccak256(code)!==r.manifest.codeHashes[to]) throw new Error('Wallet contract code differs from the verified deployment.');
  }
  const snap=await p.request({method:'eth_getBlockByNumber',params:[hex(BigInt(r.snapshot.blockNumber)),false]}) as {hash?:string}|null;
  if(snap?.hash?.toLowerCase()!==r.snapshot.blockHash) throw new Error('Review snapshot changed');
  await p.request({method:'eth_call',params:[r.transaction,'latest']});
  const gas=rpcInteger(await p.request({method:'eth_estimateGas',params:[r.transaction]}))*120n/100n;
  const gasPrice=rpcInteger(await p.request({method:'eth_gasPrice'}));
  if(gas===0n || gas>15_000_000n || gasPrice===0n || gasPrice>500_000_000_000n) throw new Error('Gas exceeds pilot policy');
  if(gas>BigInt(r.gasLimit)||gasPrice>BigInt(r.gasPrice))throw new Error('Network fee increased. Review again.');
  if(rpcInteger(await p.request({method:'eth_getBalance',params:[r.transaction.from,'latest']}))<gas*gasPrice) throw new Error('Fund this wallet with test MON for fees');
  const nonce=hex(rpcInteger(await p.request({method:'eth_getTransactionCount',params:[r.transaction.from,'pending']})));
  await walletIdentity(p,r); validatePilotReview(r);
  await validatePurchaseSemantics(r,options.namespace||'pilot',options.acknowledgment);
  if(!current()) throw new Error('Account or review changed. Review again.');
  const pending:PilotPending={review:r,nonce,hash:null,started:Date.now(),login};
  save(pending);
  try {
    const hash=await p.request({method:'eth_sendTransaction',params:[{...r.transaction,nonce,gas:hex(gas),gasPrice:hex(gasPrice)}]});
    if(typeof hash!=='string' || !/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error('Hash missing');
    save({...pending,hash:hash.toLowerCase() as Hex});
  } catch(e) {
    if((e as {code?:number}).code===4001) { save(null); throw new Error('Wallet request rejected.'); }
    throw new Error('Submission outcome unknown. Check wallet activity and attach the hash before another action.');
  }
}

export async function checkPilotPending(saved:PilotPending,namespace:PilotNamespace=practiceModes.includes(saved.review.manifest.publication.mode||'')?`practice-${saved.review.manifest.pool.slice(2)}`:'pilot') {
  if(namespace.startsWith('practice-')&&saved.review.manifest.pool!=='0x'+namespace.slice(9))throw Error('Pending transaction belongs to a different collection');
  const rpc=(method:string,params:unknown[]=[])=>namespaceRpc(namespace,method,params);
  validatePilotReview(saved.review,Date.now(),true);
  if(!saved.hash) throw new Error('Attach the transaction hash from wallet activity. Do not repeat the action.');
  const tx=await rpc('eth_getTransactionByHash',[saved.hash]) as {hash:string;chainId:string;blockNumber:string;blockHash:string;from:string;to:string;input:string;value:string;nonce:string}|null;
  const receipt=await rpc('eth_getTransactionReceipt',[saved.hash]) as {transactionHash:string;blockNumber:string;blockHash:string;status:string}|null;
  if(!receipt) return 'pending';
  const wanted=saved.review.transaction;
  if(!tx || tx.hash?.toLowerCase()!==saved.hash.toLowerCase() || receipt.transactionHash?.toLowerCase()!==saved.hash.toLowerCase()
    || rpcInteger(tx.chainId)!==10143n || tx.blockHash?.toLowerCase()!==receipt.blockHash.toLowerCase() || rpcInteger(tx.blockNumber)!==rpcInteger(receipt.blockNumber)
    || tx.from.toLowerCase()!==wanted.from.toLowerCase() || tx.to.toLowerCase()!==wanted.to.toLowerCase()
    || tx.input.toLowerCase()!==wanted.data.toLowerCase() || rpcInteger(tx.value)!==0n || rpcInteger(tx.nonce)!==rpcInteger(saved.nonce)) throw new Error('Transaction does not match the reviewed call. Tracking remains open.');
  const block=await rpc('eth_getBlockByNumber',[receipt.blockNumber,false]) as {hash:string}|null;
  const head=await rpc('eth_getBlockByNumber',['latest',false]) as {number:string}|null;
  if(block?.hash.toLowerCase()!==receipt.blockHash.toLowerCase() || !head || rpcInteger(head.number)<rpcInteger(receipt.blockNumber)+1n) return 'confirming';
  if(![0n,1n].includes(rpcInteger(receipt.status))) throw new Error('Invalid receipt status');
  return rpcInteger(receipt.status)===1n?'confirmed':'reverted';
}
