import {decodeEventLog,decodeFunctionResult,encodeFunctionData,encodeEventTopics} from 'viem';
import {pilotPoolAbi} from '../shared/pilot.mjs';

// PilotPool's remainingPayout only decreases by the paid amount in redeem()
// after resolve(). Locate those decreases with archive reads, then verify the
// actual Redeemed logs. This is a positive-cash payout index, not trade history
// or cost basis. Zero-cash redemptions remain in the general event index.
export function payoutIndex({manifest,rpc,command}){
  const key=`flurbo:pilot:payouts:v1:${manifest.pool}`,start=Number(manifest.verifiedBlock);
  const tag=n=>'0x'+n.toString(16),serialize=v=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?String(x):x);
  const block=n=>rpc('eth_getBlockByNumber',[tag(n),false]);
  const read=async(fn,n)=>{
    try{return decodeFunctionResult({abi:pilotPoolAbi,functionName:fn,data:await rpc('eth_call',[{to:manifest.pool,data:encodeFunctionData({abi:pilotPoolAbi,functionName:fn})},tag(n)])});}
    catch{throw Object.assign(Error('Historical payout state unavailable'),{code:'PAYOUT_ARCHIVE_UNAVAILABLE'});}
  };
  async function events(n){
    const header=await block(n),raw=await rpc('eth_getLogs',[{address:manifest.pool,fromBlock:tag(n),toBlock:tag(n),topics:encodeEventTopics({abi:pilotPoolAbi,eventName:'Redeemed'})}]);
    return raw.map(l=>{
      if(l.removed||l.address.toLowerCase()!==manifest.pool||Number(BigInt(l.blockNumber))!==n||l.blockHash.toLowerCase()!==header.hash.toLowerCase()||!/^0x[0-9a-f]{64}$/i.test(l.transactionHash))throw Error('Invalid payout log');
      const d=decodeEventLog({abi:pilotPoolAbi,data:l.data,topics:l.topics,strict:true});
      if(d.eventName!=='Redeemed')throw Error('Unexpected payout event');
      return {name:d.eventName,args:d.args,hash:l.transactionHash,index:Number(BigInt(l.logIndex)),block:n,blockHash:header.hash,timestamp:Number(BigInt(header.timestamp))};
    }).filter(l=>l.args.collateralAmount>0n);
  }
  async function first(lo,hi,predicate){while(lo<hi){const mid=Math.floor((lo+hi)/2);if(await predicate(mid))hi=mid;else lo=mid+1;}return lo;}
  async function scan(){
    const [prior,anchor,head]=await Promise.all([command('GET',key),block(start),rpc('eth_getBlockByNumber',['latest',false])]);
    if(anchor.hash.toLowerCase()!==manifest.verifiedBlockHash)throw Error('Payout anchor changed');
    const target=Number(BigInt(head.number))-2,targetBlock=await block(target);
    let saved=prior?JSON.parse(prior):null;
    if(saved&&(saved.through>target||(await block(saved.through)).hash.toLowerCase()!==saved.hash))saved=null;
    const resolved=await read('resolved',target);
    if(!resolved)return {logs:[],complete:true,through:target,target};
    let cursor,liability,logs;
    if(saved){cursor=saved.through;liability=BigInt(saved.liability);logs=saved.logs;}
    else{
      if(await read('resolved',start))throw Error('An unresolved deployment anchor is required');
      cursor=await first(start+1,target,n=>read('resolved',n));
      logs=await events(cursor);liability=await read('requiredCollateral',cursor);
    }
    const endLiability=await read('requiredCollateral',target);
    if(endLiability>liability)throw Error('Payout liability increased');
    let count=0;
    while(liability>endLiability&&count++<4){
      const next=await first(cursor+1,target,async n=>(await read('requiredCollateral',n))<liability);
      const after=await read('requiredCollateral',next),batch=await events(next);
      if(batch.reduce((sum,l)=>sum+l.args.collateralAmount,0n)!==liability-after)throw Error('Payout logs do not reconcile');
      logs.push(...batch);cursor=next;liability=after;
    }
    const complete=liability===endLiability,through=complete?target:cursor,checkpoint=await block(through);
    // The fixed target header commits the entire scanned ancestry, including all
    // historical binary-search reads. Never persist through a reorganization.
    if((await block(target)).hash!==targetBlock.hash||(await block(start)).hash!==anchor.hash)throw Error('Payout snapshot changed');
    const unique=[...new Map(logs.map(l=>[`${l.hash}:${l.index}`,l])).values()].sort((a,b)=>a.block-b.block||a.index-b.index);
    const next=serialize({through,hash:checkpoint.hash.toLowerCase(),liability,logs:unique});
    if(next.length>750000)throw Error('Payout index capacity reached');
    const cas="local current=redis.call('GET',KEYS[1]); if (current or '')~=ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); return 1";
    if(Number(await command('EVAL',cas,1,key,prior||'',next))!==1)throw Error('Payout index advanced in another request');
    return {...JSON.parse(next),complete,target};
  }
  let active=null;
  return {refresh(){if(!active)active=scan().finally(()=>{active=null;});return active;}};
}

// Hosted providers may serve current balances without historical contract state.
// Retry the whole verified scan, not individual answers mixed between providers.
export function payoutIndexWithFallback({fallbackRpc,...options}){
  const primary=payoutIndex(options),fallback=fallbackRpc?payoutIndex({...options,rpc:fallbackRpc}):null;
  let active=null;
  async function refresh(){
    try{return await primary.refresh();}
    catch(error){
      if(error.code!=='PAYOUT_ARCHIVE_UNAVAILABLE'||!fallback)throw error;
      if(BigInt(await fallbackRpc('eth_chainId',[]))!==10143n)throw Error('Wrong payout archive network');
      // Anchor, checkpoint, fixed-head and payout/log reconciliation checks all
      // run again. A missing payout is never converted to a successful zero.
      return fallback.refresh();
    }
  }
  return {refresh(){if(!active)active=refresh().finally(()=>{active=null;});return active;}};
}
