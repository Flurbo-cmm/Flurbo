import {createHash} from 'node:crypto';
import {decodeFunctionResult,encodeFunctionData} from 'viem';
import {pilotPoolAbi,pilotCash} from '../shared/pilot.mjs';
import {encodeClaim} from '../shared/claims.mjs';
import {validateThesisInput} from '../shared/thesis.mjs';
import {certifiedPair,certifiedClaim} from './pair-math.mjs';

// Bounded read-only comparison. No user forecasts, wallets or notes reach this service.
export function thesisAnalytics({service,rpc,now=()=>Math.floor(Date.now()/1000)}) {
  const {manifest}=service;let active=null;
  return async input=>{
    const candidates=validateThesisInput(input,manifest.publication.draft.events.length),key=JSON.stringify(input);
    if(active){if(active.key===key)return active.response;throw Error('Thesis reader busy');}
    const work=(async()=>{
      const snapshot=await service.snapshot(),tag='0x'+BigInt(snapshot.blockNumber).toString(16);
      const read=async(name,args=[])=>decodeFunctionResult({abi:pilotPoolAbi,functionName:name,data:await rpc('eth_call',[{to:manifest.pool,data:encodeFunctionData({abi:pilotPoolAbi,functionName:name,args})},tag])});
      const names=['eventCount','liquidity','eliminationOrder','factors','collateralDecimals','collateral','funded','resolved','closesAt'];
      const [events,liquidity,order,factors,decimals,collateral,funded,resolved,closesAt]=rpc.readBatch
        ?await rpc.readBatch(names.map(fn=>({to:manifest.pool,abi:pilotPoolAbi,fn,args:[]})),tag)
        :await Promise.all(names.map(name=>read(name)));
      if(events!==manifest.publication.draft.events.length||decimals!==6||collateral.toLowerCase()!==pilotCash||!funded||Number(closesAt)!==manifest.publication.draft.closesAt)throw Error('Unsupported thesis pool');
      const closed=resolved||Math.max(now(),snapshot.timestamp)>=Number(closesAt);
      const state={events,liquidity:String(liquidity),order,factors:factors.map(f=>({scope:f.scope,values:f.values.map(String)}))};
      // The pair reader's first index is the target, second is the condition.
      let pair=null,scenarios=null,analyticsAvailable=true;
      try{
        pair=certifiedPair({...state,a:input.b,b:input.a});
        scenarios=[0,1,2,3].map(s=>{const c=encodeClaim({events,rule:'AND',legs:[{event:input.a,yes:!!(s&1)},{event:input.b,yes:!!(s&2)}]});return certifiedClaim(state,c.scope,c.mask).values.market;});
      }catch{analyticsAvailable=false;}
      const rows=[];
      for(const claim of candidates){
        let probability=null,costAtoms=null,reason=closed?'market_closed':null;
        if(analyticsAvailable)probability=certifiedClaim(state,claim.scope,claim.mask).values.market;
        if(!closed){
          if(BigInt(input.quantity)>liquidity)reason='quantity_limit';
          else try{const cost=await read('quoteBuy',[claim.scope,BigInt(claim.mask),BigInt(input.quantity)]);if(cost<=0n||cost>BigInt(input.quantity))throw Error('Invalid cost');costAtoms=String(cost);}catch{reason='quote_unavailable';}
        }
        rows.push({...claim,probability,costAtoms,maxSpendAtoms:costAtoms===null?null:((BigInt(costAtoms)*10050n+9999n)/10000n).toString(),reason});
      }
      if((await rpc('eth_getBlockByNumber',[tag,false]))?.hash?.toLowerCase()!==snapshot.blockHash||now()-snapshot.timestamp>=60||now()<snapshot.timestamp-15||!closed&&now()>=Number(closesAt))throw Error('Thesis snapshot expired');
      return {schema:'flurbo.thesis.v1',chainId:10143,pool:manifest.pool,rulesHash:manifest.rulesHash,eventIds:[manifest.publication.draft.events[input.a].id,manifest.publication.draft.events[input.b].id],input,snapshot,expiresAt:snapshot.timestamp+60,stateDigest:createHash('sha256').update(JSON.stringify(state)).digest('hex'),closed,resolved,unit:'tenths_of_percentage_point',pair,scenarios,candidates:rows,maxTradeQuantityAtoms:String(liquidity<100_000_000n?liquidity:100_000_000n)};
    })();
    let timer;const response=Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Thesis read timed out')),30000);})]);
    active={key,response};work.then(()=>{clearTimeout(timer);active=null;},()=>{clearTimeout(timer);active=null;});return response;
  };
}
