import { encodeFunctionData,decodeFunctionResult } from 'viem';
import { pilotPoolAbi } from '../shared/pilot.mjs';
import { pilotService } from './pilot.mjs';
import { pairAnalytics } from './pair-analytics.mjs';

// Public reads only. Configuration, chain state and manual acceptance are separate claims.
export async function checkMockReadiness({manifest,namespace,featured=false,request=fetch,rpc,model,now=()=>Math.floor(Date.now()/1000)}){
  if(namespace!=='pilot'&&namespace!==`practice-${manifest.pool.slice(2)}`)throw Error('Invalid collection binding');
  if((['rehearsal','ethereum-activity','deterministic-source-v1'].includes(manifest.publication.mode))!==(namespace!=='pilot'))throw Error('Invalid collection mode');
  const service=pilotService({manifest,rpc,now}),checks=[];
  async function check(name,fn){
    try{checks.push({name,status:'pass',details:await fn()});}
    catch(error){checks.push({name,status:'fail',code:['HOSTED_DIAGNOSTIC_NOT_DEPLOYED','HOSTED_COLLECTION_MISMATCH'].includes(error?.readinessCode)?error.readinessCode:'CHECK_NOT_VERIFIED',details:'Could not verify this check. No transaction was sent; upstream details withheld.'});}
  }
  const hosted=(path,post)=>request('https://flurbo.singu.online'+path,{method:post?'POST':'GET',redirect:'error',credentials:'omit',
    headers:post?{'Content-Type':'application/json',Origin:'https://flurbo.singu.online'}:{},body:post?JSON.stringify(post):undefined,signal:AbortSignal.timeout(60_000)});
  await check('Hosted collection matches the saved deployment'+(featured?' and is featured':''),async()=>{
    const response=await hosted('/healthz'),health=await response.json();
    if(!response.ok||health.service!=='flurbo')throw Error('Unavailable');
    if(namespace.startsWith('practice-')){
      const collections=health.practice_collections,entry=collections?.configured?.find(row=>row.namespace===namespace);
      if(!collections)throw Object.assign(Error(),{readinessCode:'HOSTED_DIAGNOSTIC_NOT_DEPLOYED'});
      if(!entry||entry.pool!==manifest.pool||entry.rulesHash!==manifest.rulesHash||entry.closesAt!==manifest.publication.draft.closesAt
        ||featured&&collections.active!==namespace)throw Object.assign(Error(),{readinessCode:'HOSTED_COLLECTION_MISMATCH'});
    }else if(health[namespace+'_pool']!=='configured'||health[namespace+'_address']!==manifest.pool||health[namespace+'_rules_hash']!==manifest.rulesHash)throw Error('Deployment mismatch');
    return {pool:manifest.pool,chainState:health.chain_state,notice:'Configuration only; live chain checks are separate.'};
  });
  await check('Markets, account, history and What-if APIs require login',async()=>{
    const paths=[['/api/practice-collections'],['/api/'+namespace+'/status'],['/api/'+namespace+'/markets'],
      ['/api/'+namespace+'/account?wallet='+manifest.publication.creator],['/api/'+namespace+'/history',{owner:manifest.publication.creator}],['/api/'+namespace+'/analytics',{a:0,b:1}]];
    for(const [path,body] of paths)if((await hosted(path,body)).status!==401)throw Error('Expected login guard');
    return 'All six requests returned HTTP 401 without a session.';
  });
  await check('Consumer pages and security headers',async()=>{
    for(const path of ['/','/markets','/portfolio','/history',namespace==='pilot'?'/events':'/markets/'+namespace+'/0']){
      const response=await hosted(path);
      if(!response.ok||!response.headers.get('content-type')?.includes('text/html')||!response.headers.get('content-security-policy')?.includes("frame-ancestors 'none'")||response.headers.get('cache-control')!=='no-store')throw Error('Page unavailable');
      await response.arrayBuffer();
    }
    return 'Five SPA routes served with expected headers. Browser login and interaction still need manual acceptance.';
  });
  await check('Live collateral, deployment binding and supported quotes',async()=>{
    const state=await service.status();
    if(state.resolved||state.snapshot.timestamp>=manifest.publication.draft.closesAt||BigInt(state.poolCash)<BigInt(state.requiredCollateral))throw Error('Trading unavailable');
    const tag='0x'+BigInt(state.snapshot.blockNumber).toString(16),quotes=[];
    for(const [claim,scope,mask] of [['A Yes',1,2n],['A No',1,1n],['A Yes AND B Yes',3,8n],['A Yes OR B Yes',3,14n]]){
      const data=encodeFunctionData({abi:pilotPoolAbi,functionName:'quoteBuy',args:[scope,mask,1000000n]});
      const amount=decodeFunctionResult({abi:pilotPoolAbi,functionName:'quoteBuy',data:await rpc('eth_call',[{to:manifest.pool,data},tag])});
      if(amount<=0n||amount>1000000n)throw Error('Unexpected quote');quotes.push({claim,quantityAtoms:'1000000',costAtoms:amount.toString()});
    }
    if((await rpc('eth_getBlockByNumber',[tag,false]))?.hash?.toLowerCase()!==state.snapshot.blockHash)throw Error('Snapshot changed');
    return {snapshot:state.snapshot,poolCashAtoms:state.poolCash,requiredCollateralAtoms:state.requiredCollateral,quotes,notice:'Quotes do not check a trader balance or guarantee execution.'};
  });
  await check('Live What-if, independence comparison and price sensitivity',async()=>{
    const analytics=pairAnalytics({service,rpc,model,now}),result=await analytics({a:0,b:1});
    if(result.closed||result.sensitivity.scenarios.some(row=>row.status!=='available'))throw Error('Analytics incomplete');
    return {pool:result.pool,snapshot:result.snapshot,stateDigest:result.stateDigest,values:result.values,unit:result.unit,
      scenarios:result.sensitivity.scenarios,notice:'Local service calculation over live chain data with Rust cross-check. This does not verify the authenticated hosted UI.'};
  });
  return {schema:'flurbo.mock-readiness.v2',namespace,pool:manifest.pool,resolver:manifest.resolver,checkedAt:new Date(now()*1000).toISOString(),
    status:checks.every(c=>c.status==='pass')?'ready_for_manual_trading_checks':'attention_required',checks,
    manual:['Mera login, refresh and signing unlock','Approval followed by a single purchase; rejection and pending reload recovery',
      'MetaMask and Mera holdings stay separate; select September and October collections','Hosted What-if before and after a reviewed combined trade',
      'Public settlement, delivery and redemption after the committed deadlines'],
    notice:'Read-only checks are not end-to-end wallet acceptance, continuous monitoring, an audit or proof of correct outcomes. No transaction or email was sent.'};
}
