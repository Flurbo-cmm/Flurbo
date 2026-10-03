import {createHash} from 'node:crypto';
import {activityOutcome,activityMetrics,validateActivityDraft} from '../shared/ethereum-activity.mjs';
import {ETHEREUM_RPC_SOURCES} from '../shared/settlement-sources.mjs';
// The same two endpoints are published to members as each activity question's settlement source.
export const ETHEREUM_SOURCES=ETHEREUM_RPC_SOURCES;
const hash=v=>typeof v==='string'&&/^0x[0-9a-f]{64}$/.test(v);
const uint=v=>{if(typeof v!=='string'||!/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(v)||v.length>66)throw Error('Invalid Ethereum quantity');return BigInt(v);};
export function activityBlock(value){
  if(!value||!hash(value.hash)||!hash(value.parentHash)||!Array.isArray(value.transactions)||value.transactions.length>10000||!value.transactions.every(hash))throw Error('Malformed Ethereum block');
  const b={hash:value.hash,parentHash:value.parentHash,number:uint(value.number),timestamp:uint(value.timestamp),gasUsed:uint(value.gasUsed),gasLimit:uint(value.gasLimit),baseFeePerGas:uint(value.baseFeePerGas),blobGasUsed:uint(value.blobGasUsed),transactions:value.transactions.length};
  if(b.gasLimit===0n||b.gasUsed>b.gasLimit||b.blobGasUsed%131072n!==0n||b.number>BigInt(Number.MAX_SAFE_INTEGER)||b.timestamp>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Invalid Ethereum fields');
  return b;
}
export function ethereumRpc(endpoint,request=fetch){
  if(!ETHEREUM_SOURCES.includes(endpoint))throw Error('Ethereum source is not allowlisted');
  let id=0;
  return async(method,params=[])=>{
    if(!['eth_chainId','eth_getBlockByNumber'].includes(method))throw Error('Ethereum evidence reads only');
    const callId=++id,response=await request(endpoint,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:callId,method,params}),signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw Error('Ethereum source unavailable');
    let body='',size=0;const decoder=new TextDecoder();
    for await(const chunk of response.body){size+=chunk.length;if(size>2_000_000)throw Error('Ethereum response too large');body+=decoder.decode(chunk,{stream:true});}
    body+=decoder.decode();const data=JSON.parse(body);
    if(data.id!==callId||data.jsonrpc!=='2.0'||data.error||data.result===undefined)throw Error('Ethereum source rejected read');return data.result;
  };
}
const serialize=v=>JSON.parse(JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x));
async function observe(rpc,target,now){
  if(uint(await rpc('eth_chainId',[]))!==1n)throw Error('Wrong evidence chain');
  const read=async number=>{
    const b=activityBlock(await rpc('eth_getBlockByNumber',[typeof number==='string'?number:'0x'+number.toString(16),false]));
    if(typeof number==='bigint'&&b.number!==number)throw Error('Block number mismatch');return b;
  };
  const head=await read('finalized');
  if(head.timestamp>BigInt(now+15)||head.timestamp<BigInt(now-1800)||head.timestamp<BigInt(target))throw Error('Fresh finalized Ethereum head unavailable');
  let low=head.number>4096n?head.number-4096n:0n,high=head.number;
  if((await read(low)).timestamp>=BigInt(target))throw Error('Target outside bounded search');
  while(high-low>1n){const middle=(high+low)/2n;if((await read(middle)).timestamp>=BigInt(target))high=middle;else low=middle;}
  const block=await read(high),parent=await read(high-1n);
  if(block.parentHash!==parent.hash||block.timestamp<BigInt(target)||parent.timestamp>=BigInt(target)||parent.timestamp>=block.timestamp
    ||block.timestamp>=BigInt(target+1800)||block.number>head.number)throw Error('Selected block or parent mismatch');
  if((await read(head.number)).hash!==head.hash)throw Error('Finalized anchor changed');
  return {block,parent,finalized:serialize({number:head.number,hash:head.hash,timestamp:head.timestamp})};
}
export async function observeEthereumActivity(draft,{rpcs=ETHEREUM_SOURCES.map(url=>ethereumRpc(url)),now=Math.floor(Date.now()/1000)}={}){
  const target=validateActivityDraft(draft);
  if(!Number.isSafeInteger(now)||now<target+1800)throw Error('Observation window still open');
  if(rpcs.length!==2)throw Error('Two Ethereum providers required');
  const observations=await Promise.all(rpcs.map(rpc=>observe(rpc,target,now)));
  const first=observations[0];
  if(JSON.stringify(serialize({block:first.block,parent:first.parent}))!==JSON.stringify(serialize({block:observations[1].block,parent:observations[1].parent})))throw Error('Ethereum providers disagree');
  const report={schema:'flurbo.ethereum-activity-evidence.v1',target,fetchedAt:now,
    block:serialize(first.block),parent:serialize(first.parent),outcomes:activityMetrics(draft).map(metric=>activityOutcome(metric,first.block,first.parent)),
    sources:observations.map((o,i)=>({endpoint:ETHEREUM_SOURCES[i],finalized:o.finalized})),
    notice:'Corroborated RPC observations, not a cryptographic proof. Bonded assertions remain challengeable.'};
  return {...report,digest:createHash('sha256').update(JSON.stringify(report)).digest('hex')};
}
// A single immutable snapshot serves the collection's assertions across worker runs.
export async function activityEvidence(manifest,command,archive,owner,observeFn=observeEthereumActivity){
  validateActivityDraft(manifest.publication.draft);
  const key=`flurbo:activity:v1:${manifest.pool}:${manifest.rulesHash}`;
  let raw=await command('GET',key);
  if(!raw){const report=await observeFn(manifest.publication.draft);await command('SET',key,JSON.stringify(report),'NX');raw=await command('GET',key);}
  const saved=JSON.parse(raw),{digest,...report}=saved;
  if(createHash('sha256').update(JSON.stringify(report)).digest('hex')!==digest||report.target!==manifest.publication.draft.closesAt+120||report.schema!=='flurbo.ethereum-activity-evidence.v1'
    ||report.outcomes?.length!==activityMetrics(manifest.publication.draft).length||report.outcomes.some(o=>![1,2].includes(o)))throw Error('Stored Ethereum observation mismatch');
  return async event=>{
    if(!Number.isInteger(event)||event<0||event>=report.outcomes.length)throw Error('Invalid event');
    const q=manifest.publication.draft.events[event],outcome=report.outcomes[event];
    const evidence=await archive.put({eventId:q.id,outcome,statement:`Ethereum block ${report.block.number}: ${q.question} Source-checked result: ${outcome===2?'YES':'NO'}. Rules and archived measurements determine this proposal.`,
      sourceURL:`https://etherscan.io/block/${report.block.number}`,attachment:JSON.stringify({rulesHash:manifest.rulesHash,report:saved})},owner,manifest.draftHash);
    return {...evidence,outcome};
  };
}
