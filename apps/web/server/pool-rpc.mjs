import {rpcFetch} from './rpc-capacity.mjs';
import {testnetRpcHost} from './network.mjs';
import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem';

// allowLocal is for local development tooling only (an anvil chain on this machine); hosted configuration never sets it.
export function poolRpc(endpoint,request=fetch,{allowLocal=false}={}) {
  const url=new URL(endpoint);
  const local=allowLocal&&url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)&&!url.username&&!url.password;
  if(!local&&(url.protocol!=='https:'||url.username||url.password||url.hash||url.port||!testnetRpcHost(url.hostname)))throw new Error('Public Monad testnet RPC required');
  let id=0;
  const rpc=async(method,params=[])=>{
    if(!['eth_chainId','eth_getBlockByNumber','eth_getCode','eth_call','eth_estimateGas','eth_gasPrice','eth_getLogs'].includes(method))throw new Error('Pool service is read-only');
    const callId=++id;
    const response=await rpcFetch(request,endpoint,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:callId,method,params}),signal:AbortSignal.timeout(15_000)});
    if(!response.ok && ![400,413].includes(response.status))throw new Error('Pool RPC unavailable');
    const chunks=[];let size=0;
    for await(const chunk of response.body){size+=chunk.length;if(size>1_000_000)throw new Error('Pool RPC response too large');chunks.push(chunk);}
    const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(result.id!==callId||result.jsonrpc!=='2.0')throw new Error('Pool RPC rejected the read');
    if(result.error) {
      // Keep provider details (which may contain credentials) out of errors.
      const error=new Error('Pool RPC rejected the read');
      if(method==='eth_getLogs' && /block range|range.{0,40}(limit|large|exceed)|limit.{0,40}range|too many (results|logs)|response size/i.test(String(result.error.message||''))) error.code='LOG_RANGE_LIMIT';
      throw error;
    }
    if(!response.ok||!Object.hasOwn(result,'result'))throw new Error('Pool RPC rejected the read');
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
