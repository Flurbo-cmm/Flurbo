import {CapacityError,requestLimits} from './request-limits.mjs';

// Only the hosted web process installs this controller. Settlement jobs keep
// their own transport, so web queues cannot strand a settlement transaction.
let hostedController=null;
export function installRpcCapacity(options) { hostedController=createRpcCapacity(options); }
export const rpcFetch=(request,url,init)=>hostedController?hostedController(request,url,init):request(url,init);

export function createRpcCapacity({command,now=Date.now,concurrency=6,maxQueued=32,unitsPerMinute=1200}={}) {
  const limits=requestLimits({command,now});let active=0,cooldown=0;const queue=[];
  const abortError=()=>new DOMException('Request cancelled','AbortError');
  function acquire(signal) {
    if(signal?.aborted)return Promise.reject(abortError());
    if(active<concurrency){active++;return Promise.resolve();}
    if(queue.length>=maxQueued)return Promise.reject(new CapacityError(2));
    return new Promise((resolve,reject)=>{
      const entry={resolve,reject,signal,abort:null};
      entry.abort=()=>{const i=queue.indexOf(entry);if(i>=0)queue.splice(i,1);reject(abortError());};
      signal?.addEventListener('abort',entry.abort,{once:true});queue.push(entry);
    });
  }
  function release(){const next=queue.shift();if(next){next.signal?.removeEventListener('abort',next.abort);next.resolve();}else active--;}
  return async(request,url,init)=>{
    if(now()<cooldown)throw new CapacityError((cooldown-now())/1000);
    await acquire(init.signal);
    try {
      if(init.signal?.aborted)throw abortError();
      if(now()<cooldown)throw new CapacityError((cooldown-now())/1000);
      const body=JSON.parse(init.body),calls=Array.isArray(body)?body:[body];
      const units=calls.reduce((sum,c)=>sum+(c.method==='eth_getLogs'?10:['eth_call','eth_estimateGas'].includes(c.method)?2:1),0);
      await limits.take('rpc',unitsPerMinute,Math.max(1,units));
      const response=await request(url,init);
      // Hold the slot until the response body finishes, not just the headers.
      const chunks=[];let size=0;
      for await(const chunk of response.body||[]){size+=chunk.length;if(size>1_000_000)throw Error('RPC response too large');chunks.push(chunk);}
      if(response.status===429){
        const raw=response.headers.get('Retry-After'),seconds=raw&&/^\d+$/.test(raw)?Number(raw):raw?Math.ceil((Date.parse(raw)-now())/1000):60;
        const wait=Number.isFinite(seconds)?Math.max(1,seconds):60;cooldown=Math.max(cooldown,now()+wait*1000);throw new CapacityError(wait);
      }
      return new Response(Buffer.concat(chunks),{status:response.status,headers:response.headers});
    } finally {release();}
  };
}
