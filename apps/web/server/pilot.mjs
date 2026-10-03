import {rpcFetch} from './rpc-capacity.mjs';
import {testnetRpcHost} from './network.mjs';
import { decodeFunctionResult, encodeFunctionData, keccak256, stringToHex, parseAbi } from 'viem';
import { pilotCash, pilotCashAbi, pilotPoolAbi, resolverAbi, pilotCall, evidenceURI, validClaim, combinationFits, COMBINATION_LIMIT_MESSAGE } from '../shared/pilot.mjs';
import { ApplicationError } from './access-applications.mjs';
import {holderResolverAbi,dependsOnEvent,challengeCandidates} from '../shared/holder-challenge.mjs';
import {assessSemantics} from './semantic-validation.mjs';
import {DETERMINISTIC_MODE,validateSettlementManifest} from './settlement-publication.mjs';

const address = value => {
  if(typeof value!=='string' || !/^0x[0-9a-f]{40}$/i.test(value) || /^0x0{40}$/i.test(value)) throw new Error('Invalid wallet');
  return value.toLowerCase();
};
const uint = value => { if(typeof value!=='string' || !/^(0|[1-9][0-9]{0,30})$/.test(value)) throw new Error('Invalid amount'); return BigInt(value); };
const json = value => JSON.parse(JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v));

// allowLocal is for local development tooling only (an anvil chain on this machine); hosted configuration never sets it.
export function pilotRpc(endpoint,request=fetch,{allowLocal=false}={}) {
  const url=new URL(endpoint);
  const local=allowLocal&&url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)&&!url.username&&!url.password;
  if(!local&&(url.protocol!=='https:'||url.username||url.password||url.hash||url.port||!testnetRpcHost(url.hostname)))throw new Error('Public Monad testnet RPC required');
  let id=0;
  const rpc=async(method,params=[])=>{
    if(!['eth_chainId','eth_getBlockByNumber','eth_getCode','eth_call','eth_estimateGas','eth_gasPrice','eth_getLogs'].includes(method))throw new Error('Pilot service is read-only');
    const callId=++id;
    const response=await rpcFetch(request,endpoint,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:callId,method,params}),signal:AbortSignal.timeout(15_000)});
    if(!response.ok && ![400,413].includes(response.status))throw new Error('Pilot RPC unavailable');
    const chunks=[];let size=0;
    for await(const chunk of response.body){size+=chunk.length;if(size>1_000_000)throw new Error('Pilot RPC response too large');chunks.push(chunk);}
    const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(result.id!==callId||result.jsonrpc!=='2.0')throw new Error('Pilot RPC rejected the read');
    if(result.error) {
      // Keep provider details (which may contain credentials) out of errors.
      const error=new Error('Pilot RPC rejected the read');
      if(method==='eth_getLogs' && /block range|range.{0,40}(limit|large|exceed)|limit.{0,40}range|too many (results|logs)|response size/i.test(String(result.error.message||''))) error.code='LOG_RANGE_LIMIT';
      throw error;
    }
    if(!response.ok||!Object.hasOwn(result,'result'))throw new Error('Pilot RPC rejected the read');
    return result.result;
  };
  // The same deployed Multicall3 used by the proposer guard. This is eth_call,
  // never a transaction. A failed inner read fails the whole response.
  const aggregateAbi=parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)']);
  rpc.readBatch=async(calls,tag)=>{
    if(calls.length>60)throw Error('Read batch too large');
    const data=encodeFunctionData({abi:aggregateAbi,functionName:'aggregate3',args:[calls.map(c=>({target:c.to,allowFailure:false,callData:encodeFunctionData({abi:c.abi,functionName:c.fn,args:c.args})}))]});
    const rows=decodeFunctionResult({abi:aggregateAbi,functionName:'aggregate3',data:await rpc('eth_call',[{to:'0xca11bde05977b3631167028862be2a173976ca11',data},tag])});
    if(rows.length!==calls.length||rows.some(r=>!r.success))throw Error('Incomplete read batch');
    return rows.map((row,i)=>decodeFunctionResult({abi:calls[i].abi,functionName:calls[i].fn,data:row.returnData}));
  };
  return rpc;
}

export function pilotService({manifest, rpc, now=()=>Math.floor(Date.now()/1000), snapshotReuseMs=0}) {
  if(manifest?.publication?.mode===DETERMINISTIC_MODE || manifest?.publication?.settlementRules !== undefined
    || manifest?.publication?.draft?.events?.some(event => event.source?.recordId?.startsWith('settlement-rule:'))) validateSettlementManifest(manifest);
  if(manifest?.schema!=='flurbo.pilot-manifest.v1' || manifest.status!=='verified_pilot_snapshot' || manifest.chainId!==10143
    || ![2,3,4].includes(manifest.publication?.draft?.events?.length) || ![3,5].includes(manifest.publication?.reviewers?.length)) throw new Error('Verified pilot manifest required');
  address(manifest.pool); address(manifest.resolver);
  if(manifest.challengePolicy&&(manifest.challengePolicy.version!=='account-holders-v1'||address(manifest.challengePolicy.authority)!==manifest.challengePolicy.authority))throw Error('Invalid holder challenge policy');
  for(const key of [manifest.pool,manifest.resolver]) if(!/^0x[0-9a-f]{64}$/.test(manifest.codeHashes?.[key]||'')) throw new Error('Compiled pilot evidence required');
  const tagFor = s=>'0x'+BigInt(s.blockNumber).toString(16);
  async function read(to,abi,functionName,args=[],tag='latest') {
    const data=encodeFunctionData({abi,functionName,args});
    return decodeFunctionResult({abi,functionName,data:await rpc('eth_call',[{to,data},tag])});
  }
  // Several reads at one block: one Multicall3 eth_call when the RPC supports it (every read must succeed), or the
  // same reads in parallel otherwise. Results come back in order.
  async function readMany(calls,tag) {
    if(rpc.readBatch&&calls.length>1)return rpc.readBatch(calls.map(([to,abi,fn,args=[]])=>({to,abi,fn,args})),tag);
    return Promise.all(calls.map(([to,abi,fn,args=[]])=>read(to,abi,fn,args,tag)));
  }
  // Holdings pages from one Portfolio visit arrive together; with snapshotReuseMs set, they share one verified
  // snapshot for that long instead of re-verifying the deployment for each page. Each page still checks that
  // the snapshot block is canonical (stable) before answering. Other reads always take a fresh snapshot.
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
    // Code and bindings at the same head block, checked together in one round.
    const [codes,bindings]=await Promise.all([
      Promise.all([manifest.pool,manifest.resolver].map(to=>rpc('eth_getCode',[to,head.number]))),
      Promise.all([read(manifest.pool,pilotPoolAbi,'settlementRulesHash',[],head.number),read(manifest.resolver,resolverAbi,'pool',[],head.number),
        ...(manifest.challengePolicy?[read(manifest.resolver,holderResolverAbi,'eligibilitySigner',[],head.number)]:[])])]);
    [manifest.pool,manifest.resolver].forEach((to,i)=>{if(keccak256(codes[i])!==manifest.codeHashes[to]) throw new Error('Contract code changed');});
    const [rulesHash,boundPool,signer]=bindings;
    if(rulesHash.toLowerCase()!==manifest.rulesHash||boundPool.toLowerCase()!==manifest.pool) throw new Error('Pilot binding changed');
    if(manifest.challengePolicy&&signer.toLowerCase()!==manifest.challengePolicy.authority)throw Error('Challenge authority changed');
    return {blockNumber:BigInt(head.number).toString(),blockHash:head.hash.toLowerCase(),timestamp:Number(BigInt(head.timestamp))};
  }
  async function stable(s) { if((await rpc('eth_getBlockByNumber',[tagFor(s),false]))?.hash?.toLowerCase()!==s.blockHash) throw new Error('Snapshot changed'); }
  async function account(owner) {
    owner=address(owner);
    const s=await snapshot();
    const cash=await read(pilotCash,pilotCashAbi,'balanceOf',[owner],tagFor(s));
    // A traded scope is retained in the pool's factor tables. Use it to discover
    // candidate combinations without waiting for the historical event index.
    // A scope says nothing about this wallet's ownership; positions() checks that.
    const factors=await read(manifest.pool,pilotPoolAbi,'factors',[],tagFor(s));
    const claimScopes=[...new Set(factors.map(f=>f.scope))];
    await stable(s);
    return json({manifest,snapshot:s,wallet:{address:owner,cash},claimScopes});
  }
  // Identical status requests that arrive while one is being read share it: a page load asks for the same status
  // several times at once. Each read still takes its own verified snapshot.
  const statusReads=new Map();
  async function status(owner) {
    const key=owner?address(owner):'';
    if(!statusReads.has(key))statusReads.set(key,readStatus(owner).finally(()=>statusReads.delete(key)));
    return statusReads.get(key);
  }
  async function readStatus(owner) {
    const s=await snapshot(), tag=tagFor(s), count=manifest.publication.draft.events.length;
    // Every value comes from one block, in a single batched read.
    const events=Array.from({length:count},(_,i)=>i);
    const values=await readMany([
      ...events.flatMap(i=>[[manifest.resolver,resolverAbi,'caseState',[i]],[manifest.resolver,resolverAbi,'assertionDeadline',[i]],
        ...(owner?[[manifest.resolver,resolverAbi,'voted',[i,owner]]]:[])]),
      [manifest.pool,pilotPoolAbi,'liquidity'],[manifest.pool,pilotPoolAbi,'factors'],[manifest.pool,pilotPoolAbi,'eliminationOrder'],
      [manifest.resolver,resolverAbi,'delivered'],[manifest.pool,pilotPoolAbi,'requiredCollateral'],[pilotCash,pilotCashAbi,'balanceOf',[manifest.pool]],
      [manifest.pool,pilotPoolAbi,'resolved'],[manifest.pool,pilotPoolAbi,'voidMask'],
      ...(owner?[[pilotCash,pilotCashAbi,'balanceOf',[owner]],[manifest.resolver,resolverAbi,'credits',[owner]],[manifest.resolver,resolverAbi,'isReviewer',[owner]]]:[])],tag);
    const per=owner?3:2, cases=events.map(i=>({...values[i*per],assertionDeadline:values[i*per+1],voted:owner?values[i*per+2]:false}));
    const [liquidity,factors,order,delivered,requiredCollateral,poolCash,resolved,voidMask,cash,credits,reviewer]=values.slice(count*per);
    // The combinations already priced by the pool and its elimination order let the ticket show, before any
    // request, which further combinations the pool can still accept (see combinationFits).
    const result={manifest,snapshot:s,cases,maxTradeQuantityAtoms:liquidity<100_000_000n?liquidity:100_000_000n,
      factorScopes:[...new Set(factors.map(f=>Number(f.scope)))],eliminationOrder:order.map(Number),delivered,requiredCollateral,poolCash,resolved,voidMask,
      wallet:owner?{address:owner,cash,credits,reviewer}:null};
    await stable(s); return json(result);
  }
  // One verified snapshot for the browse page. Prices are one-share buy costs,
  // never promises of execution or wallet approvals.
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
    const events=manifest.publication.draft.events;
    let prices;
    if(open&&rpc.readBatch){
      const values=await rpc.readBatch(events.flatMap((_,event)=>[2n,1n].map(mask=>({to:manifest.pool,abi:pilotPoolAbi,fn:'quoteBuy',args:[2**event,mask,1_000_000n]}))),tag);
      prices=events.map((_,event)=>({event,yes:values[event*2],no:values[event*2+1]}));
    }else prices=await Promise.all(events.map(async(_,event)=>({event,
      yes:open?await read(manifest.pool,pilotPoolAbi,'quoteBuy',[2**event,2n,1_000_000n],tag):null,
      no:open?await read(manifest.pool,pilotPoolAbi,'quoteBuy',[2**event,1n,1_000_000n],tag):null})));
    await stable(s);return json({manifest,snapshot:s,open,resolved,prices});
  }
  async function prepare(input) {
    if(!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(k=>!['owner','action','event','outcome','evidenceHash','evidenceURI','scope','mask','quantity','slippageBps','authorization','signature'].includes(k))) throw new Error('Invalid action');
    if((input.authorization||input.signature)&&(!manifest.challengePolicy||input.action!=='dispute'))throw Error('Unexpected challenge authorization');
    const owner=address(input.owner), s=await snapshot(), tag=tagFor(s);
    let to=manifest.resolver, abi=resolverAbi, name=input.action, args=[], amount=0n, minimumReceived=0n, title=name, quotedCost=null, impact=null;
    if(['assertOutcome','dispute','vote'].includes(name)) {
      if(!Number.isInteger(input.event) || input.event<0 || input.event>=manifest.publication.draft.events.length || ![1,2,3].includes(input.outcome)
        || !/^0x[0-9a-f]{64}$/i.test(input.evidenceHash||'') || /^0x0{64}$/.test(input.evidenceHash) || !evidenceURI(input.evidenceURI)) throw new Error('Evidence and outcome required');
      args=[input.event,input.outcome,input.evidenceHash,input.evidenceURI];
      const c=await read(manifest.resolver,resolverAbi,'caseState',[input.event],tag);
      const reviewer=await read(manifest.resolver,resolverAbi,'isReviewer',[owner],tag);
      if(name==='assertOutcome') {
        const end=manifest.publication.draft.events[input.event].observationEndsAt;
        if(reviewer || c.phase!==0 || s.timestamp<end || s.timestamp>=end+manifest.publication.assertionPeriod)throw new Error('Assertion window is not open for this wallet');
      }else if(name==='dispute') {
        if(reviewer || c.phase!==1 || c.asserter.toLowerCase()===owner || c.proposal===input.outcome || BigInt(s.timestamp)>=c.challengeUntil)throw new Error('Challenge is not available for this wallet and outcome');
        if(manifest.challengePolicy){
          if(!input.authorization||!input.signature||input.authorization.challenger!==owner)throw Error('Account eligibility authorization required');
          abi=holderResolverAbi;args.push(input.authorization,input.signature);
        }
      }else if(!reviewer || c.phase!==2 || BigInt(s.timestamp)>=c.voteUntil || await read(manifest.resolver,resolverAbi,'voted',[input.event,owner],tag))throw new Error('Vote is not available for this reviewer');
      if(name!=='vote') amount=BigInt(manifest.publication.bondAtoms);
    } else if(name==='finalize') {
      if(!Number.isInteger(input.event) || input.event<0 || input.event>=manifest.publication.draft.events.length) throw new Error('Invalid event');
      args=[input.event];
    } else if(['buy','sell','redeem'].includes(name)) {
      to=manifest.pool; abi=pilotPoolAbi;
      const mask=uint(input.mask), quantity=uint(input.quantity);
      if(!validClaim(input.scope,mask,manifest.publication.draft.events.length) || quantity===0n || quantity>100_000_000n) throw new Error('Unsupported claim or quantity');
      args=[input.scope,mask,quantity];
      if(name!=='buy' && await read(to,abi,'holdings',[owner,input.scope,mask],tag)<quantity) throw new Error('Not enough shares in this wallet');
      if(name==='buy'){
        const [factors,order]=await Promise.all([read(to,abi,'factors',[],tag),read(to,abi,'eliminationOrder',[],tag)]);
        if(!combinationFits(manifest.publication.draft.events.length,order.map(Number),factors.map(f=>Number(f.scope)),input.scope))throw new ApplicationError(409,COMBINATION_LIMIT_MESSAGE);
      }
      if(name!=='redeem') {
        if(![10,50,100].includes(input.slippageBps)) throw new Error('Choose a supported slippage limit');
        const quote=await read(to,abi,name==='buy'?'quoteBuy':'quoteSell',args,tag);
        // Price impact for the ticket: this size against one share of the same claim, at the same block.
        impact={quoteAtoms:quote.toString(),oneShareAtoms:(await read(to,abi,name==='buy'?'quoteBuy':'quoteSell',[input.scope,mask,1_000_000n],tag)).toString()};
        const limit=name==='buy'?(quote*BigInt(10000+input.slippageBps)+9999n)/10000n:quote*BigInt(10000-input.slippageBps)/10000n;
        const deadline=Math.min(s.timestamp+300,manifest.publication.draft.closesAt-1);
        args.push(limit,BigInt(deadline));
        if(name==='buy') {amount=limit;quotedCost=quote;}
        else minimumReceived=limit;
      }
    } else if(!['deliver','withdrawBond'].includes(name)) throw new Error('Unsupported pilot action');
    const originalData=encodeFunctionData({abi,functionName:name,args});
    if(!pilotCall({to,data:originalData,manifest})) throw new Error('Action exceeds pilot policy');
    if(amount) {
      if(await read(pilotCash,pilotCashAbi,'balanceOf',[owner],tag)<amount) throw new Error('Not enough test AUSD in this wallet');
      if(await read(pilotCash,pilotCashAbi,'allowance',[owner,to],tag)<amount) {
        title=`Approve ${input.action}`; args=[to,amount]; to=pilotCash; abi=pilotCashAbi; name='approve';
      }
    }
    const data=encodeFunctionData({abi,functionName:name,args}), transaction={from:owner,to,data,value:'0x0',chainId:'0x279f'};
    await rpc('eth_call',[transaction,tag]);
    const gasLimit=BigInt(await rpc('eth_estimateGas',[transaction]))*120n/100n;
    const gasPrice=BigInt(await rpc('eth_gasPrice',[]));
    if(gasLimit<=0n || gasLimit>15_000_000n || gasPrice<=0n || gasPrice>500_000_000_000n) throw new Error('Gas exceeds pilot policy');
    await stable(s);
    // Informational only: the browser re-checks before the wallet prompt, so a failed check here must not break the review.
    let semanticAssessment=null;
    if(input.action==='buy')try{semanticAssessment=assessSemantics(manifest,{scope:input.scope,mask:input.mask,quantityAtoms:input.quantity});}catch{}
    return json({schema:'flurbo.pilot-review.v1',manifest,snapshot:s,expiresAt:s.timestamp+300,action:name,requested:input,title,semanticAssessment,
      amountAtoms:amount.toString(),quotedCostAtoms:quotedCost?.toString()??null,impact,minimumReceivedAtoms:minimumReceived.toString(),gasLimit:gasLimit.toString(),gasPrice:gasPrice.toString(),maximumFeeWei:(gasLimit*gasPrice).toString(),
      transaction,notice:name==='approve'?'Approve the exact token allowance, then review the intended action separately.':'Review the outcome, evidence and wallet before confirming.'});
  }
  async function position(owner,scope,mask) {
    address(owner); const m=uint(mask);
    if(!validClaim(scope,m,manifest.publication.draft.events.length)) throw new Error('Unsupported claim');
    const s=await snapshot(),tag=tagFor(s);
    const quantity=await read(manifest.pool,pilotPoolAbi,'holdings',[owner,scope,m],tag);
    const resolved=await read(manifest.pool,pilotPoolAbi,'resolved',[],tag);
    const fraction=resolved?await read(manifest.pool,pilotPoolAbi,'payoutFraction',[scope,m],tag):null;
    await stable(s);
    return json({snapshot:s,owner,scope,mask,quantity,payoutAtoms:fraction?quantity*fraction[0]/fraction[1]:null,fraction});
  }
  async function positions(owner,claims) {
    address(owner);
    if(!Array.isArray(claims)||claims.length>60)throw new Error('Use pages of at most sixty claims');
    const s=await snapshot({reuse:true}),tag=tagFor(s),resolved=await read(manifest.pool,pilotPoolAbi,'resolved',[],tag),rows=[];
    // Validate the entire request before doing holdings reads. Bound parallelism
    // so a page does not serialize sixty RPC round trips (or burst sixty).
    for(const claim of claims){
      const mask=uint(claim.mask);
      if(!validClaim(claim.scope,mask,manifest.publication.draft.events.length))throw new Error('Unsupported claim');
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
  async function stakeAt(event,stake,s){
    if(!stake||Object.keys(stake).sort().join(',')!=='holder,mask,scope,wrapped'||typeof stake.wrapped!=='boolean')throw Error('Invalid holding witness');
    const holder=address(stake.holder),mask=uint(stake.mask),tag=tagFor(s);
    if(!dependsOnEvent(stake.scope,mask,event,manifest.publication.draft.events.length))return false;
    if(manifest.challengePolicy)return read(manifest.resolver,holderResolverAbi,'hasQualifyingShares',[holder,event,stake.scope,mask,stake.wrapped],tag);
    if(stake.wrapped){
      if(stake.scope!==2**event||![1n,2n].includes(mask))return false;
      const token=await read(manifest.pool,pilotPoolAbi,'baseTokens',[stake.scope,Number(mask)],tag);
      return !/^0x0{40}$/.test(token)&&await read(token,pilotCashAbi,'balanceOf',[holder],tag)>0n;
    }
    return await read(manifest.pool,pilotPoolAbi,'holdings',[holder,stake.scope,mask],tag)>0n;
  }
  async function challengeStake(event,stake){
    const s=await snapshot();
    if(!Number.isInteger(event)||event<0||event>=manifest.publication.draft.events.length)throw Error('Invalid event');
    const c=await read(manifest.resolver,resolverAbi,'caseState',[event],tagFor(s));
    const eligible=c.phase===1&&BigInt(s.timestamp)<c.challengeUntil&&await stakeAt(event,stake,s);
    await stable(s);return json({eligible,snapshot:s,challengeUntil:c.challengeUntil});
  }
  async function challengeEligibility(wallets,event,cursor=0){
    if(!Array.isArray(wallets)||wallets.length>20||!Number.isSafeInteger(cursor)||cursor<0||!Number.isInteger(event)||event<0||event>=manifest.publication.draft.events.length)throw Error('Invalid eligibility request');
    wallets=wallets.map(address);
    const s=await snapshot(),tag=tagFor(s),factors=await read(manifest.pool,pilotPoolAbi,'factors',[],tag);
    const candidates=challengeCandidates(wallets,event,manifest.publication.draft.events.length,[...new Set(factors.map(f=>f.scope))]);
    // Bounded continuation prevents a wallet with no positions from causing an unbounded RPC scan.
    const page=candidates.slice(cursor,cursor+24);let witness=null;
    for(let i=0;i<page.length&&!witness;i+=4){const batch=page.slice(i,i+4),checks=await Promise.all(batch.map(stake=>stakeAt(event,stake,s)));witness=batch.find((_,j)=>checks[j])||null;}
    await stable(s);return json({eligible:!!witness,stake:witness,nextCursor:witness||cursor+24>=candidates.length?null:cursor+24,snapshot:s});
  }
  return {manifest,status,account,markets,prepare,snapshot,position,positions,challengeStake,challengeEligibility};
}

export function pilotEvidence(command, origin, now=()=>Date.now()) {
  const key=hash=>`flurbo:pilot:evidence:v1:${hash}`;
  return {
    async put(input,login,draftHash) {
      if(!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(k=>!['eventId','outcome','statement','sourceURL','attachment'].includes(k))
        || typeof input.eventId!=='string' || input.eventId.length>96 || ![1,2,3].includes(input.outcome)
        || typeof input.statement!=='string' || input.statement.trim().length<20 || input.statement.length>8000
        || !evidenceURI(input.sourceURL) || typeof input.attachment!=='string' || input.attachment.length>12000) throw new Error('Provide bounded public evidence');
      const body=JSON.stringify({schema:'flurbo.pilot-evidence.v1',draftHash,uploader:login,eventId:input.eventId,outcome:input.outcome,
        statement:input.statement,sourceURL:input.sourceURL,attachment:input.attachment});
      const hash=keccak256(stringToHex(body));
      if(await command('GET',key(hash))===body) return {hash,uri:`${origin}/api/pilot/evidence/${hash}`,body};
      // Durable account and service caps bound new uploads across restarts. Reusing identical evidence is free.
      const hour=Math.floor(now()/3_600_000);
      const quota="local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],7200) end; return n";
      const accountCount=Number(await command('EVAL',quota,1,`flurbo:pilot:evidence-quota:${hour}:${login}`));
      if(!Number.isSafeInteger(accountCount)||accountCount<1||accountCount>20) throw new Error('Evidence upload limit reached. Reuse stored evidence or retry next hour.');
      const serviceCount=Number(await command('EVAL',quota,1,`flurbo:pilot:evidence-quota:${hour}:all`));
      if(!Number.isSafeInteger(serviceCount)||serviceCount<1||serviceCount>200) throw new Error('Evidence service upload limit reached. Retry next hour.');
      // No expiry: evidence must outlive a login, deployment and settlement. Immutable by content hash.
      await command('SET',key(hash),body,'NX');
      if(await command('GET',key(hash))!==body) throw new Error('Evidence persistence failed');
      return {hash,uri:`${origin}/api/pilot/evidence/${hash}`,body};
    },
    async get(hash) {
      if(!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error('Invalid evidence hash');
      const body=await command('GET',key(hash));
      if(typeof body!=='string' || keccak256(stringToHex(body))!==hash) throw new Error('Evidence unavailable');
      return body;
    },
  };
}
