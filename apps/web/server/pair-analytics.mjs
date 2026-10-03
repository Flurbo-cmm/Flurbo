import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { decodeFunctionResult, encodeFunctionData } from 'viem';
import { pilotCash, pilotPoolAbi } from '../shared/pilot.mjs';
import { certifiedPair, pairInput } from './pair-math.mjs';
import { simulatePairPurchase } from './pair-sensitivity.mjs';

const binary=fileURLToPath(new URL('../../../bin/flurbo-pair-analytics'+(process.platform==='win32'?'.exe':''),import.meta.url));
export function runPairModel(input,{file=binary}={}) {
  return new Promise((resolve,reject)=>{
    const child=execFile(file,[],{timeout:5000,maxBuffer:8192,windowsHide:true,encoding:'utf8',
      env:process.platform==='win32'?{SystemRoot:process.env.SystemRoot}:{}},(error,stdout)=>{
      if(error)return reject(new Error('Pair calculation unavailable'));
      try{resolve(JSON.parse(stdout));}catch{reject(new Error('Invalid pair calculation'));}
    });
    child.stdin.on('error',()=>{});child.stdin.end(input);
  });
}

export function pairAnalytics({service,rpc,model=runPairModel,now=()=>Math.floor(Date.now()/1000)}) {
  const {manifest}=service;
  let active=null;
  async function calculate({a,b}){
    const snapshot=await service.snapshot(),tag='0x'+BigInt(snapshot.blockNumber).toString(16);
    const read=async (name,args=[])=>decodeFunctionResult({abi:pilotPoolAbi,functionName:name,
      data:await rpc('eth_call',[{to:manifest.pool,data:encodeFunctionData({abi:pilotPoolAbi,functionName:name,args})},tag])});
    const [events,liquidity,order,factors,decimals,collateral,funded,resolved,closesAt]=await Promise.all(
      ['eventCount','liquidity','eliminationOrder','factors','collateralDecimals','collateral','funded','resolved','closesAt'].map(name=>read(name)));
    if(events!==manifest.publication.draft.events.length||decimals!==6||collateral.toLowerCase()!==pilotCash
      ||!funded||resolved||BigInt(manifest.publication.draft.closesAt)!==closesAt)throw new Error('Unsupported analytics pool');
    const state={events,a,b,liquidity:liquidity.toString(),order,factors:factors.map(f=>({scope:f.scope,values:f.values.map(String)}))};
    async function certify(inputState){
      const input=pairInput(inputState),certified=certifiedPair(inputState),reference=await model(input);
      for(const [key,value] of Object.entries(certified.values)){
        const actual=reference?.[key];
        if(typeof actual!=='number'||!Number.isFinite(actual)||actual< (key==='difference'?-1:0)||actual>1)throw new Error('Invalid analytics result');
        if(value!==null&&Math.round(Math.abs(actual)*1000)*Math.sign(actual)!==value)throw new Error('Analytics precision disagreement');
      }
      return certified;
    }
    const input=pairInput(state),certified=await certify(state);
    const closed=now()>=Number(closesAt);
    const scenarios=[];
    for(const answer of ['yes','no']){
      const unavailable=reason=>({answer,status:'unavailable',reason});
      if(closed){scenarios.push(unavailable('market_closed'));continue;}
      let simulated;
      try{simulated=simulatePairPurchase(state,answer);}
      catch{scenarios.push(unavailable('unsupported_simulation'));continue;}
      let cost;
      try{
        cost=await read('quoteBuy',[simulated.scope,BigInt(simulated.mask),BigInt(simulated.quantity)]);
        if(typeof cost!=='bigint'||cost<=0n||cost>BigInt(simulated.quantity))throw new Error('Invalid quote');
      }catch{scenarios.push(unavailable('quote_unavailable'));continue;}
      // A precision disagreement rejects the response, rather than showing an unchecked result.
      const after=await certify(simulated.after);
      scenarios.push({answer,status:'available',scope:simulated.scope,mask:simulated.mask,
        quantityAtoms:simulated.quantity,costAtoms:cost.toString(),...after});
    }
    const current=await rpc('eth_getBlockByNumber',[tag,false]);
    if(current?.hash?.toLowerCase()!==snapshot.blockHash||now()-snapshot.timestamp>=60||now()<snapshot.timestamp-15)throw new Error('Analytics snapshot expired');
    if(!closed&&now()>=Number(closesAt))throw new Error('Market closed during calculation');
    return {schema:'flurbo.pair-analytics.v1',model:'factored-lmsr-pair-v1',chainId:10143,pool:manifest.pool,rulesHash:manifest.rulesHash,
      snapshot,expiresAt:snapshot.timestamp+60,stateDigest:createHash('sha256').update(input).digest('hex'),
      a,b,unit:'tenths_of_percentage_point',...certified,closed,
      sensitivity:{schema:'flurbo.pair-sensitivity.v1',scenarios}};
  }
  return async input=>{
    if(!input||Array.isArray(input)||typeof input!=='object'||Object.keys(input).sort().join(',')!=='a,b'
      ||![input.a,input.b].every(x=>Number.isInteger(x)&&x>=0&&x<manifest.publication.draft.events.length)||input.a===input.b)throw new Error('Choose two different events');
    const key=input.a+':'+input.b;
    if(active){if(active.key===key)return active.response;throw new Error('Analytics reader busy');}
    let timer;
    const work=calculate(input);
    const response=Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Analytics read timed out')),30_000);})]);
    active={key,response};
    // Keep the concurrency slot until upstream reads finish, even after a client timeout.
    work.then(()=>{clearTimeout(timer);active=null;},()=>{clearTimeout(timer);active=null;});
    return response;
  };
}
