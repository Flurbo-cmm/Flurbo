import {createHash} from 'node:crypto';

// Store aggregate quotes only: never wallet addresses, trade hashes or sizes.
// First sample per five-minute bucket wins across processes. Retain at most
// 288 observations for 30 days; sampling is demand-driven, not a price indexer.
export const appendPriceSample=`-- flurbo-price-sample-v1
if redis.call('ZCOUNT',KEYS[1],ARGV[1],ARGV[1])==0 then
  redis.call('ZADD',KEYS[1],ARGV[1],ARGV[2])
end
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',tonumber(ARGV[1])-2592000)
redis.call('ZREMRANGEBYRANK',KEYS[1],0,-289)
redis.call('EXPIRE',KEYS[1],2592000)
return redis.call('ZRANGE',KEYS[1],-288,-1)`;

export function priceHistory({service,command,now=()=>Math.floor(Date.now()/1000)}){
  const m=service.manifest,count=m.publication.draft.events.length;
  const key='flurbo:prices:v1:'+createHash('sha256').update(`${m.chainId}:${m.pool}:${m.rulesHash}`).digest('hex');
  let pending=null,cached=null,expires=0;
  function point(sample){
    if(!sample||!Number.isSafeInteger(sample.timestamp)||sample.timestamp<0||sample.timestamp>now()+15
      ||!/^\d{1,30}$/.test(sample.blockNumber)||!/^0x[0-9a-f]{64}$/i.test(sample.blockHash)
      ||!Array.isArray(sample.prices)||sample.prices.length!==count)throw Error('Invalid price sample');
    const prices=sample.prices.map((p,event)=>{
      if(p.event!==event||![p.yes,p.no].every(v=>v===null||typeof v==='string'&&/^\d{1,7}$/.test(v)&&BigInt(v)<=2_000_000n))throw Error('Invalid price sample');
      return {event,yes:p.yes,no:p.no};
    });
    return {timestamp:sample.timestamp,blockNumber:sample.blockNumber,blockHash:sample.blockHash,prices};
  }
  function decode(rows){
    if(!Array.isArray(rows)||rows.length>288)throw Error('Invalid price archive');
    const points=rows.map(row=>point(JSON.parse(row))).filter(p=>p.timestamp>=now()-2592000);
    if(points.some((p,i)=>i>0&&p.timestamp<=points[i-1].timestamp))throw Error('Unordered price archive');
    return points;
  }
  async function load(){
    let points=decode(await command('ZRANGE',key,-288,-1)),sampling='current';
    const bucket=Math.floor(now()/300)*300;
    if(!points.length||Math.floor(points.at(-1).timestamp/300)*300<bucket){
      try{
        const value=await service.markets();
        if(value.manifest.pool!==m.pool||value.manifest.rulesHash!==m.rulesHash||now()-value.snapshot.timestamp>180)throw Error('Invalid quote binding');
        const sample=point({...value.snapshot,prices:value.prices});
        // A closed market does not have a buy quote. Preserve the last real price.
        if(value.open)points=decode(await command('EVAL',appendPriceSample,1,key,Math.floor(sample.timestamp/300)*300,JSON.stringify(sample)));
        else sampling='closed';
      }catch{sampling='unavailable';}
    }
    return {schema:'flurbo.price-history.v1',pool:m.pool,rulesHash:m.rulesHash,unit:'test_AUSD_per_share',sampleIntervalSeconds:300,
      sampling,points,notice:'Sampled when this market is viewed. Up to 288 observations from the last 30 days. Gaps are not reconstructed; these are one-share buy quotes, not probabilities.'};
  }
  return {async read(){
    if(cached&&now()<expires)return cached;
    if(!pending)pending=load().then(result=>{cached=result;expires=now()+30;return result;}).finally(()=>{pending=null;});
    return pending;
  }};
}
