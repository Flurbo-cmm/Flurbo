import { decodeFunctionResult, encodeFunctionData, keccak256 } from 'viem';
import { pilotCash, pilotCashAbi, pilotPoolAbi, pilotCall, validClaim, combinationFits, COMBINATION_LIMIT_MESSAGE } from '../shared/pilot.mjs';
import { ApplicationError } from './access-applications.mjs';
import { assessSemantics } from './semantic-validation.mjs';
import { settlementRuleHash } from './settlement-rules.mjs';
import { hybridSettlementCatalog } from './hybrid-settlement-worker.mjs';
import { pairAnalytics } from './pair-analytics.mjs';
import { claimAnalytics } from './claim-analytics.mjs';

// Hybrid pools with two to four questions, served to agents and SDKs as protocol v1 pools under the namespace
// practice-<pool address without 0x>. The manifest is synthetic: it keeps the legacy schema and status names the
// browser review and the agent code check, and is built only from the verified catalog and the chain anchor.
export const AGENT_MIN_QUESTIONS = 2;
export const AGENT_MAX_QUESTIONS = 4;
export const agentNamespace = pool => `practice-${pool.toLowerCase().slice(2)}`;

const address = value => {
  if(typeof value!=='string' || !/^0x[0-9a-f]{40}$/i.test(value) || /^0x0{40}$/i.test(value)) throw new Error('Invalid wallet');
  return value.toLowerCase();
};
const uint = value => { if(typeof value!=='string' || !/^(0|[1-9][0-9]{0,30})$/.test(value)) throw new Error('Invalid amount'); return BigInt(value); };
const json = value => JSON.parse(JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v));
const lowerAddress = value => typeof value==='string' && /^0x[0-9a-f]{40}$/.test(value) && !/^0x0{40}$/.test(value);
const hash32 = value => typeof value==='string' && /^0x[0-9a-f]{64}$/.test(value);
const agentPool = record => record.prepared.draft.events.length>=AGENT_MIN_QUESTIONS && record.prepared.draft.events.length<=AGENT_MAX_QUESTIONS;

const referenceUrl = urls => {
  try { const url=new URL(urls[0]); url.search=''; url.hash=''; return url.href; } catch { return null; }
};

export function hybridEventRules(event) {
  if(event.route==='reality') return {
    yesRule:'YES if the Reality.eth answer for this question finalises as Yes.',
    noRule:'NO if the Reality.eth answer for this question finalises as No. An Invalid or unanswered question settles VOID.',
    source:event.source?.ruleURI?{publisher:'Reality.eth on Sepolia',referenceUrl:event.source.ruleURI,recordId:`reality:${event.source.questionId}`}:null };
  const decision=event.rule?.decision;
  const condition=decision&&typeof decision.type==='string'&&typeof decision.operator==='string'&&decision.value!==undefined
    ?`${decision.type} ${decision.operator} ${JSON.stringify(decision.value)}`:null;
  let source=null;
  try { source={publisher:event.rule.source.publisher,referenceUrl:referenceUrl(event.rule.source.urls??[]),recordId:`settlement-rule:sha256:${settlementRuleHash(event.rule)}`}; }
  catch { source=null; }
  return condition?{
    yesRule:`YES if the valid source record selected by the committed rule satisfies ${condition}. Missing or ambiguous evidence does not mean NO.`,
    noRule:`NO if the valid source record selected by the committed rule does not satisfy ${condition}. Missing or ambiguous evidence follows the committed VOID timeout.`,
    source}:{
    yesRule:'YES if the committed source rule resolves to YES. Missing or ambiguous evidence does not mean NO.',
    noRule:'NO if the committed source rule resolves to NO. Missing or ambiguous evidence follows the committed VOID timeout.',
    source};
}

export function hybridPoolManifest(record, { verifiedBlockHash, codeHashes }) {
  const {prepared}=record, draft=prepared.draft;
  return {schema:'flurbo.pilot-manifest.v1',status:'verified_pilot_snapshot',chainId:10143,
    pool:record.pool.toLowerCase(),resolver:record.resolver.toLowerCase(),rulesHash:record.rulesHash.toLowerCase(),draftHash:prepared.draftHash.toLowerCase(),
    verifiedBlock:String(record.deploymentBlock),verifiedBlockHash:String(verifiedBlockHash).toLowerCase(),
    codeHashes:Object.fromEntries(Object.entries(codeHashes).map(([key,value])=>[key.toLowerCase(),value])),
    publication:{mode:'hybrid-v4',creator:prepared.creator.toLowerCase(),bondAtoms:draft.bondAtoms,
      assertionPeriod:draft.assertionPeriod,challengePeriod:draft.challengePeriod,
      settlementRules:draft.events.map(event=>event.route==='mechanical'?structuredClone(event.rule):null),
      draft:{title:draft.title,closesAt:draft.closesAt,events:draft.events.map(event=>({id:event.id,question:event.question,...hybridEventRules(event),
        observationStartsAt:null,observationEndsAt:event.observationEndsAt,route:event.route}))}}};
}

// Trust on first use of the chain, the same assumption hybridPoolIndexes makes for its anchor.
export async function readHybridPoolAnchor({ record, rpc }) {
  const pool=record.pool.toLowerCase(), resolver=record.resolver.toLowerCase();
  const [block,poolCode,resolverCode]=await Promise.all([rpc('eth_getBlockByNumber',['0x'+BigInt(record.deploymentBlock).toString(16),false]),
    rpc('eth_getCode',[pool,'latest']),rpc('eth_getCode',[resolver,'latest'])]);
  if(!/^0x[0-9a-fA-F]{64}$/.test(block?.hash||'')) throw new Error('Hybrid deployment block unavailable');
  for(const code of [poolCode,resolverCode]) if(typeof code!=='string'||!/^0x[0-9a-fA-F]*$/.test(code)||code==='0x') throw new Error('Hybrid contract code unavailable');
  return {verifiedBlockHash:block.hash.toLowerCase(),codeHashes:{[pool]:keccak256(poolCode),[resolver]:keccak256(resolverCode)}};
}

export function hybridPoolService({ manifest, rpc, now=()=>Math.floor(Date.now()/1000), snapshotReuseMs=0 }) {
  const events=manifest?.publication?.draft?.events;
  if(manifest?.schema!=='flurbo.pilot-manifest.v1' || manifest.status!=='verified_pilot_snapshot' || manifest.chainId!==10143
    || manifest.publication?.mode!=='hybrid-v4' || !Array.isArray(events) || events.length<AGENT_MIN_QUESTIONS || events.length>AGENT_MAX_QUESTIONS
    || !lowerAddress(manifest.pool) || !lowerAddress(manifest.resolver)
    || !hash32(manifest.codeHashes?.[manifest.pool]) || !hash32(manifest.codeHashes?.[manifest.resolver])) throw new Error('Verified hybrid pool manifest required');
  const count=events.length, tagFor=s=>'0x'+BigInt(s.blockNumber).toString(16);
  async function read(to,abi,functionName,args=[],tag='latest') {
    const data=encodeFunctionData({abi,functionName,args});
    return decodeFunctionResult({abi,functionName,data:await rpc('eth_call',[{to,data},tag])});
  }
  // Holdings pages from one Portfolio visit share one verified snapshot for snapshotReuseMs; other reads take a fresh one.
  let recent=null;
  async function snapshot({reuse=false}={}) {
    if(reuse&&snapshotReuseMs>0&&recent&&Date.now()-recent.at<snapshotReuseMs)return recent.value;
    const value=freshSnapshot();
    if(snapshotReuseMs>0){const entry={at:Date.now(),value};recent=entry;value.catch(()=>{if(recent===entry)recent=null;});}
    return value;
  }
  async function freshSnapshot() {
    const [chain,anchor,head]=await Promise.all([rpc('eth_chainId',[]),rpc('eth_getBlockByNumber',['0x'+BigInt(manifest.verifiedBlock).toString(16),false]),rpc('eth_getBlockByNumber',['latest',false])]);
    if(BigInt(chain)!==10143n) throw new Error('Wrong network');
    if(anchor?.hash?.toLowerCase()!==manifest.verifiedBlockHash) throw new Error('Deployment anchor changed');
    if(!head || !/^0x[0-9a-f]{64}$/i.test(head.hash) || now()-Number(BigInt(head.timestamp))>180 || now()-Number(BigInt(head.timestamp)) < -15) throw new Error('Stale chain data');
    // Code and the pool's binding at the same head block, checked together in one round.
    const [codes,bindings]=await Promise.all([
      Promise.all([manifest.pool,manifest.resolver].map(to=>rpc('eth_getCode',[to,head.number]))),
      Promise.all(['settlementRulesHash','resolver','eventCount'].map(fn=>read(manifest.pool,pilotPoolAbi,fn,[],head.number)))]);
    [manifest.pool,manifest.resolver].forEach((to,i)=>{if(keccak256(codes[i])!==manifest.codeHashes[to]) throw new Error('Contract code changed');});
    const [rulesHash,boundResolver,eventCount]=bindings;
    if(rulesHash.toLowerCase()!==manifest.rulesHash||boundResolver.toLowerCase()!==manifest.resolver||Number(eventCount)!==count) throw new Error('Pool binding changed');
    return {blockNumber:BigInt(head.number).toString(),blockHash:head.hash.toLowerCase(),timestamp:Number(BigInt(head.timestamp))};
  }
  async function stable(s) { if((await rpc('eth_getBlockByNumber',[tagFor(s),false]))?.hash?.toLowerCase()!==s.blockHash) throw new Error('Snapshot changed'); }
  // One verified snapshot for the browse page. Prices are one-share buy costs, never promises of execution.
  let marketRead=null;
  function markets() {
    if(marketRead)return marketRead;
    marketRead=readMarkets().finally(()=>{marketRead=null;});
    return marketRead;
  }
  async function readMarkets() {
    const s=await snapshot(),tag=tagFor(s);
    const resolved=await read(manifest.pool,pilotPoolAbi,'resolved',[],tag);
    const open=s.timestamp<manifest.publication.draft.closesAt && !resolved;
    let prices;
    if(open&&rpc.readBatch){
      const values=await rpc.readBatch(events.flatMap((_,event)=>[2n,1n].map(mask=>({to:manifest.pool,abi:pilotPoolAbi,fn:'quoteBuy',args:[2**event,mask,1_000_000n]}))),tag);
      prices=events.map((_,event)=>({event,yes:values[event*2],no:values[event*2+1]}));
    }else prices=await Promise.all(events.map(async(_,event)=>({event,
      yes:open?await read(manifest.pool,pilotPoolAbi,'quoteBuy',[2**event,2n,1_000_000n],tag):null,
      no:open?await read(manifest.pool,pilotPoolAbi,'quoteBuy',[2**event,1n,1_000_000n],tag):null})));
    await stable(s);return json({manifest,snapshot:s,open,resolved,prices});
  }
  // Agents only buy through Flurbo reviews; selling and redeeming go straight to the pool from the agent wallet.
  async function prepare(input) {
    if(!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(k=>!['owner','action','scope','mask','quantity','slippageBps'].includes(k))) throw new Error('Invalid action');
    if(input.action!=='buy') throw new Error('Unsupported action');
    const owner=address(input.owner), s=await snapshot(), tag=tagFor(s), pool=manifest.pool;
    const mask=uint(input.mask), quantity=uint(input.quantity);
    if(!validClaim(input.scope,mask,count) || quantity===0n || quantity>100_000_000n) throw new Error('Unsupported claim or quantity');
    const [factors,order]=await Promise.all([read(pool,pilotPoolAbi,'factors',[],tag),read(pool,pilotPoolAbi,'eliminationOrder',[],tag)]);
    if(!combinationFits(count,order.map(Number),factors.map(f=>Number(f.scope)),input.scope))throw new ApplicationError(409,COMBINATION_LIMIT_MESSAGE);
    if(![10,50,100].includes(input.slippageBps)) throw new Error('Choose a supported slippage limit');
    const quote=await read(pool,pilotPoolAbi,'quoteBuy',[input.scope,mask,quantity],tag);
    // Price impact for the ticket: this size against one share of the same claim, at the same block.
    const impact={quoteAtoms:quote.toString(),oneShareAtoms:(await read(pool,pilotPoolAbi,'quoteBuy',[input.scope,mask,1_000_000n],tag)).toString()};
    const limit=(quote*BigInt(10000+input.slippageBps)+9999n)/10000n;
    const deadline=Math.min(s.timestamp+300,manifest.publication.draft.closesAt-1);
    const args=[input.scope,mask,quantity,limit,BigInt(deadline)];
    if(!pilotCall({to:pool,data:encodeFunctionData({abi:pilotPoolAbi,functionName:'buy',args}),manifest})) throw new Error('Action exceeds policy');
    let call={to:pool,abi:pilotPoolAbi,name:'buy',args},title='buy';
    if(await read(pilotCash,pilotCashAbi,'balanceOf',[owner],tag)<limit) throw new Error('Not enough test AUSD in this wallet');
    if(await read(pilotCash,pilotCashAbi,'allowance',[owner,pool],tag)<limit) {
      title='Approve buy'; call={to:pilotCash,abi:pilotCashAbi,name:'approve',args:[pool,limit]};
    }
    const data=encodeFunctionData({abi:call.abi,functionName:call.name,args:call.args}), transaction={from:owner,to:call.to,data,value:'0x0',chainId:'0x279f'};
    await rpc('eth_call',[transaction,tag]);
    const gasLimit=BigInt(await rpc('eth_estimateGas',[transaction]))*120n/100n;
    const gasPrice=BigInt(await rpc('eth_gasPrice',[]));
    if(gasLimit<=0n || gasLimit>15_000_000n || gasPrice<=0n || gasPrice>500_000_000_000n) throw new Error('Gas exceeds policy');
    await stable(s);
    // Informational only: the browser re-checks before the wallet prompt, so a failed check here must not break the review.
    let semanticAssessment=null;
    try{semanticAssessment=assessSemantics(manifest,{scope:input.scope,mask:input.mask,quantityAtoms:input.quantity});}catch{}
    return json({schema:'flurbo.pilot-review.v1',manifest,snapshot:s,expiresAt:s.timestamp+300,action:call.name,requested:input,title,semanticAssessment,
      amountAtoms:limit.toString(),quotedCostAtoms:quote.toString(),impact,minimumReceivedAtoms:'0',gasLimit:gasLimit.toString(),gasPrice:gasPrice.toString(),maximumFeeWei:(gasLimit*gasPrice).toString(),
      transaction,notice:call.name==='approve'?'Approve the exact token allowance, then review the intended action separately.':'Review the outcome, evidence and wallet before confirming.'});
  }
  async function positions(owner,claims) {
    address(owner);
    if(!Array.isArray(claims)||claims.length>60)throw new Error('Use pages of at most sixty claims');
    const s=await snapshot({reuse:true}),tag=tagFor(s),resolved=await read(manifest.pool,pilotPoolAbi,'resolved',[],tag),rows=[];
    // Validate the entire request before doing holdings reads. Bound parallelism
    // so a page does not serialize sixty RPC round trips (or burst sixty).
    for(const claim of claims){
      const mask=uint(claim.mask);
      if(!validClaim(claim.scope,mask,count))throw new Error('Unsupported claim');
    }
    if(rpc.readBatch&&claims.length){
      const quantities=await rpc.readBatch(claims.map(c=>({to:manifest.pool,abi:pilotPoolAbi,fn:'holdings',args:[owner,c.scope,uint(c.mask)]})),tag);
      const payable=claims.map((c,i)=>({c,i})).filter(({i})=>resolved&&quantities[i]>0n);
      const fractions=payable.length?await rpc.readBatch(payable.map(({c})=>({to:manifest.pool,abi:pilotPoolAbi,fn:'payoutFraction',args:[c.scope,uint(c.mask)]})),tag):[];
      const payouts=new Map(payable.map(({i},j)=>[i,quantities[i]*fractions[j][0]/fractions[j][1]]));
      claims.forEach((claim,i)=>rows.push({...claim,quantity:quantities[i],payoutAtoms:resolved?(payouts.get(i)||0n):null}));
    }else for(let offset=0;offset<claims.length;offset+=4)rows.push(...await Promise.all(claims.slice(offset,offset+4).map(async claim=>{
      const mask=uint(claim.mask),quantity=await read(manifest.pool,pilotPoolAbi,'holdings',[owner,claim.scope,mask],tag);
      const fraction=resolved&&quantity>0n?await read(manifest.pool,pilotPoolAbi,'payoutFraction',[claim.scope,mask],tag):null;
      return {...claim,quantity,payoutAtoms:resolved?(fraction?quantity*fraction[0]/fraction[1]:0n):null};
    })));
    await stable(s);return json({snapshot:s,owner,rows});
  }
  return {manifest,snapshot,markets,prepare,positions};
}

export async function hybridAgentPools({ catalog, rpc, indexes=new Map(), readAnchor=readHybridPoolAnchor,
  analytics=true, snapshotReuseMs=2500, log=console.warn, now=undefined }) {
  const records=hybridSettlementCatalog(catalog).pools;
  const reservedAddresses=new Set(records.flatMap(record=>[record.pool,record.resolver,record.prepared.creator,record.prepared.proposer,record.prepared.relay,
    record.adapter,record.manager,record.keeper,record.answerer]).filter(value=>typeof value==='string').map(value=>value.toLowerCase()));
  const collections=[], services=new Map(), reported=new Set();
  let pending=records.filter(agentPool), running=null;
  async function attach(record) {
    const pool=record.pool.toLowerCase();
    try {
      const manifest=hybridPoolManifest(record,await readAnchor({record,rpc}));
      const service=hybridPoolService({manifest,rpc,now,snapshotReuseMs}), index=indexes.get(pool), namespace=agentNamespace(pool);
      if(index?.history)service.index=index.history;
      if(index?.payouts)service.payouts=index.payouts;
      if(analytics){service.analytics=pairAnalytics({service,rpc});service.claimAnalytics=claimAnalytics({service,rpc});}
      services.set(namespace,service);
      collections.push({namespace,label:record.prepared.draft.title,pool,closesAt:record.prepared.draft.closesAt});
      return true;
    } catch {
      // Once per pool, without the error: RPC errors can carry provider details.
      if(!reported.has(pool)){reported.add(pool);log(JSON.stringify({status:'agent_pool_unavailable',pool}));}
      return false;
    }
  }
  async function retry() {
    if(!pending.length)return 'idle';
    const left=[];
    for(const record of pending)if(!await attach(record))left.push(record);
    const added=pending.length-left.length;
    pending=left;
    return `added ${added}, pending ${pending.length}`;
  }
  const refresh=()=>running??=retry().finally(()=>{running=null;});
  await refresh();
  return {collections,services,reservedAddresses,pending:()=>pending.length,refresh};
}
