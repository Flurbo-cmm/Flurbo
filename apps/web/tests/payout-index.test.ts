import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encodeFunctionResult,decodeFunctionData,encodeEventTopics,encodeAbiParameters,parseAbiParameters} from 'viem';
import {pilotPoolAbi} from '../shared/pilot.mjs';
import {payoutIndex,payoutIndexWithFallback} from '../server/payout-index.mjs';
const hash=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
function fixture(count=2){
 const pool='0x'+'11'.repeat(20),owner='0x'+'22'.repeat(20),manifest={pool,verifiedBlock:'100',verifiedBlockHash:hash(100)};
 let saved:string|null=null,calls=0,logCalls=0,bad=false,reorg=false,scanned=false;
 const command=async(...a:any[])=>{if(a[0]==='GET')return saved;if(a[4] !==(saved||''))return 0;saved=a[5];return 1;};
 const rpc=async(method:string,params:any[])=>{
  calls++;if(method==='eth_getBlockByNumber'){const n=params[0]==='latest'?1000002:Number(BigInt(params[0]));return {number:'0x'+n.toString(16),hash:hash(n+(reorg&&scanned&&n===1000000?1:0)),timestamp:'0x100'};}
  if(method==='eth_call'){
   const n=Number(BigInt(params[1])),fn=decodeFunctionData({abi:pilotPoolAbi,data:params[0].data}).functionName;
   const result=fn==='resolved'?n>=150:BigInt(count-Math.min(count,Math.max(0,Math.floor((n-200)/100)+1)))*1000000n;
   return encodeFunctionResult({abi:pilotPoolAbi,functionName:fn,result});
  }
  assert.equal(method,'eth_getLogs');assert.equal(params[0].fromBlock,params[0].toBlock);logCalls++;scanned=true;
  const n=Number(BigInt(params[0].fromBlock));if(n===150)return [];
  return [{address:pool,blockNumber:params[0].fromBlock,blockHash:hash(n),transactionHash:hash(n+1),logIndex:'0x0',topics:encodeEventTopics({abi:pilotPoolAbi,eventName:'Redeemed',args:{owner,scope:1,mask:2n}}),data:encodeAbiParameters(parseAbiParameters('uint128,uint128'),[1000000n,bad?999999n:1000000n])}];
 };
 return {manifest,rpc,command,stats:()=>({saved,calls,logCalls}),bad:()=>{bad=true;},reorg:()=>{reorg=true;}};
}
test('positive payouts load without scanning a million empty blocks and cached refresh is cheap',async()=>{
 const f=fixture(),index=payoutIndex(f),first=await index.refresh();
 assert.equal(first.complete,true);assert.equal(first.logs.length,2);assert.equal(first.logs.reduce((s:any,l:any)=>s+BigInt(l.args.collateralAmount),0n),2000000n);
 assert.equal(f.stats().logCalls,3);assert.ok(f.stats().calls<100);
 const before=f.stats().calls,second=await index.refresh();assert.equal(second.logs.length,2);assert.ok(f.stats().calls-before<12);assert.equal(f.stats().logCalls,3);
});
test('a bounded payout scan resumes across more than four payout blocks',async()=>{
 const f=fixture(6),index=payoutIndex(f),first=await index.refresh();assert.equal(first.complete,false);assert.equal(first.logs.length,4);
 const second=await index.refresh();assert.equal(second.complete,true);assert.equal(second.logs.length,6);
});
test('payout logs must match reserve decrease; reorganized reads cannot be saved',async()=>{
 const bad=fixture();bad.bad();await assert.rejects(payoutIndex(bad).refresh(),/reconcile/);assert.equal(bad.stats().saved,null);
 const reorg=fixture();reorg.reorg();await assert.rejects(payoutIndex(reorg).refresh(),/snapshot changed/);assert.equal(reorg.stats().saved,null);
});

test('provider without historical state retries a complete verified scan on the fallback',async()=>{
 const f=fixture();let fallbackCalls=0;
 const rpc=async(method:string,params:any[])=>{if(method==='eth_call')throw Error('Archive unavailable');return f.rpc(method,params);};
 const fallbackRpc=async(method:string,params:any[])=>{fallbackCalls++;if(method==='eth_chainId')return '0x279f';return f.rpc(method,params);};
 const result=await payoutIndexWithFallback({...f,rpc,fallbackRpc}).refresh();assert.equal(result.complete,true);assert.equal(result.logs.length,2);assert.ok(fallbackCalls>1);
});
test('fallback rejects the wrong network and never bypasses inconsistent payout logs',async()=>{
 const f=fixture();const rpc=async(method:string,params:any[])=>{if(method==='eth_call')throw Error();return f.rpc(method,params);};
 await assert.rejects(payoutIndexWithFallback({...f,rpc,fallbackRpc:async()=> '0x1'}).refresh(),/network/);
 const bad=fixture();bad.bad();let fallback=false;
 await assert.rejects(payoutIndexWithFallback({...bad,fallbackRpc:async()=>{fallback=true;return null;}}).refresh(),/reconcile/);assert.equal(fallback,false);
});
