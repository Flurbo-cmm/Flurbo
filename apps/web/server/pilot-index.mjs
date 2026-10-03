import { decodeEventLog } from 'viem';
import { resolverAbi, pilotPoolAbi } from '../shared/pilot.mjs';

// Persistent pilot-sized index. Each refresh scans at most 1,000 blocks. A changed
// checkpoint rebuilds from the verified empty-pool anchor instead of retaining orphaned events.
export function pilotIndex({manifest,rpc,command,now=Date.now}) {
  const key=`flurbo:pilot:index:v1:${manifest.pool}`;
  const start=Number(manifest.verifiedBlock);
  const abi=[...resolverAbi,...pilotPoolAbi];
  let windowSize=100;
  const stringify=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v);
  async function scan() {
    const prior=await command('GET',key);
    let saved=prior?JSON.parse(prior):{through:start,hash:manifest.verifiedBlockHash,logs:[]};
    const anchor=await rpc('eth_getBlockByNumber',['0x'+start.toString(16),false]);
    if(anchor?.hash?.toLowerCase()!==manifest.verifiedBlockHash)throw new Error('Pilot anchor changed');
    const checkpoint=await rpc('eth_getBlockByNumber',['0x'+saved.through.toString(16),false]);
    if(checkpoint?.hash?.toLowerCase()!==saved.hash) saved={through:start,hash:manifest.verifiedBlockHash,logs:[]};
    const head=await rpc('eth_getBlockByNumber',['latest',false]);
    const tip=Number(BigInt(head.number))-2;
    // Finish the persisted catch-up snapshot before following newly mined blocks.
    // A completed snapshot starts a new target on the next explicit refresh.
    const target=Number.isSafeInteger(saved.target)&&saved.target>saved.through?Math.min(saved.target,tip):tip;
    const targetEnd=Math.min(target,saved.through+1000);
    if(targetEnd<=saved.through)return {...saved,target,complete:saved.through>=target};
    const boundaryBefore=await rpc('eth_getBlockByNumber',['0x'+targetEnd.toString(16),false]);
    let end=saved.through,endBefore=null,attempts=0;
    const started=now();
    const logs=[];
    // Bound work per HTTP request. Smaller provider limits must never skip blocks.
    while(end<targetEnd && attempts<12 && (end===saved.through || now()-started<8000)) {
      const from=end+1,to=Math.min(targetEnd,from+windowSize-1);
      const before=await rpc('eth_getBlockByNumber',['0x'+to.toString(16),false]);
      let batch;attempts++;
      try {
        batch=await rpc('eth_getLogs',[{address:[manifest.pool,manifest.resolver],fromBlock:'0x'+from.toString(16),toBlock:'0x'+to.toString(16)}]);
      } catch(error) {
        if(error.code!=='LOG_RANGE_LIMIT'||windowSize===1)throw error;
        windowSize=windowSize===100?10:1;
        continue;
      }
      if(!Array.isArray(batch)||batch.length>2000)throw new Error('Pilot log window exceeds its bounded index');
      for(const log of batch) {
        if(log.removed || ![manifest.pool,manifest.resolver].includes(log.address?.toLowerCase()) || !/^0x[0-9a-f]{64}$/i.test(log.transactionHash||''))throw new Error('Invalid pilot log');
        const block=Number(BigInt(log.blockNumber));
        if(block<from||block>to)throw new Error('Log outside requested range');
        try {
          const decoded=decodeEventLog({abi,data:log.data,topics:log.topics,strict:true});
          logs.push({address:log.address.toLowerCase(),block,blockHash:log.blockHash,hash:log.transactionHash,index:Number(BigInt(log.logIndex)),name:decoded.eventName,args:decoded.args});
        }catch { /* Unknown events cannot establish an outcome or a holding. */ }
      }
      end=to;endBefore=before;
    }
    // Check every event block and the ending checkpoint before persisting.
    for(const block of new Set(logs.map(l=>l.block))) {
      const canonical=await rpc('eth_getBlockByNumber',['0x'+block.toString(16),false]);
      if(logs.some(l=>l.block===block&&l.blockHash.toLowerCase()!==canonical?.hash?.toLowerCase()))throw new Error('Reorganization during scan');
    }
    const endBlock=await rpc('eth_getBlockByNumber',['0x'+end.toString(16),false]);
    if(endBlock?.hash!==endBefore?.hash)throw new Error('Scan endpoint changed during reads');
    const boundaryAfter=await rpc('eth_getBlockByNumber',['0x'+targetEnd.toString(16),false]);
    if(boundaryAfter?.hash!==boundaryBefore?.hash)throw new Error('Scan boundary changed during reads');
    const oldBlock=await rpc('eth_getBlockByNumber',['0x'+saved.through.toString(16),false]);
    if(oldBlock?.hash?.toLowerCase()!==saved.hash)throw new Error('Checkpoint changed during scan');
    const merged=[...saved.logs,...logs].sort((a,b)=>a.block-b.block||a.index-b.index);
    const unique=[...new Map(merged.map(l=>[`${l.blockHash}:${l.index}`,l])).values()];
    const next={through:end,hash:endBlock.hash.toLowerCase(),target,logs:unique};
    const encoded=stringify(next);
    // Do not silently discard old activity to stay under a storage quota.
    if(encoded.length>750_000)throw new Error('Pilot index capacity reached; expand the index before continuing');
    const cas="local current=redis.call('GET',KEYS[1]); if (current or '')~=ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); return 1";
    if(Number(await command('EVAL',cas,1,key,prior||'',encoded))!==1)throw new Error('Index advanced in another request; refresh');
    return {...JSON.parse(encoded),complete:end>=target};
  }
  // Portfolio and History can open together. Share a scan in this process;
  // the Redis compare-and-swap still protects different service instances.
  let active=null;
  function refresh() {
    if(!active) active=scan().finally(()=>{active=null;});
    return active;
  }
  return {refresh};
}
