import {createHash} from 'node:crypto';
import {decodeFunctionResult,encodeFunctionData} from 'viem';
import {pilotPoolAbi,pilotCash} from '../shared/pilot.mjs';
import {validateClaim} from '../shared/claims.mjs';
import {certifiedClaim} from './pair-math.mjs';

export function claimAnalytics({service,rpc,now=()=>Math.floor(Date.now()/1000)}){
  const {manifest}=service;
  let active=null;
  return async input=>{
    if(!input||Array.isArray(input)||Object.keys(input).sort().join(',')!=='mask,scope')throw Error('Invalid claim input');
    validateClaim(input.scope,input.mask,manifest.publication.draft.events.length);
    const key=input.scope+':'+input.mask;
    if(active){if(active.key===key)return active.promise;throw Error('Claim reader busy');}
    const work=(async()=>{
      const snapshot=await service.snapshot(),tag='0x'+BigInt(snapshot.blockNumber).toString(16);
      const read=async name=>decodeFunctionResult({abi:pilotPoolAbi,functionName:name,data:await rpc('eth_call',[{to:manifest.pool,data:encodeFunctionData({abi:pilotPoolAbi,functionName:name})},tag])});
      const [events,liquidity,order,factors,decimals,collateral,funded,resolved,closesAt]=await Promise.all(['eventCount','liquidity','eliminationOrder','factors','collateralDecimals','collateral','funded','resolved','closesAt'].map(read));
      if(events!==manifest.publication.draft.events.length||decimals!==6||collateral.toLowerCase()!==pilotCash||!funded||resolved||Number(closesAt)!==manifest.publication.draft.closesAt)throw Error('Unsupported analytics pool');
      const state={events,liquidity:String(liquidity),order,factors:factors.map(f=>({scope:f.scope,values:f.values.map(String)}))};
      const result=certifiedClaim(state,input.scope,input.mask);
      const current=await rpc('eth_getBlockByNumber',[tag,false]);
      if(current?.hash?.toLowerCase()!==snapshot.blockHash||now()-snapshot.timestamp>=60||now()<snapshot.timestamp-15)throw Error('Snapshot expired');
      return {schema:'flurbo.claim-analytics.v1',model:'bounded-lmsr-enumeration-v1',chainId:10143,pool:manifest.pool,rulesHash:manifest.rulesHash,
        ...input,snapshot,expiresAt:snapshot.timestamp+60,stateDigest:createHash('sha256').update(JSON.stringify(state)).digest('hex'),
        unit:'tenths_of_percentage_point',closed:now()>=Number(closesAt),...result};
    })();
    let timer;
    const promise=Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Claim analysis timed out')),30_000);})]);
    active={key,promise};work.then(()=>{clearTimeout(timer);active=null;},()=>{clearTimeout(timer);active=null;});
    return promise;
  };
}
