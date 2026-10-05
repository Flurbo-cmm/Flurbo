import {appFetch} from './platform-fetch.ts';
import {isHybridNamespace,type HybridNamespace} from './portfolio-groups.ts';

const OPERATIONS:Record<string,'GET'|'POST'>={account:'GET',positions:'POST',history:'POST','collected-payouts':'POST'};
export async function hybridPoolRequest<T>(path:string,input:unknown,namespace:HybridNamespace,signal:AbortSignal):Promise<T>{
  if(!isHybridNamespace(namespace))throw Error('Invalid collection');
  const operation=path.split('?')[0],method=OPERATIONS[operation];
  if(!method)throw Error('Unsupported portfolio request');
  const pool=namespace.slice('hybrid-'.length);
  const response=await appFetch(`/api/hybrid/pool/${pool}/${operation}`,{method,credentials:'same-origin',cache:'no-store',
    headers:method==='POST'?{'Content-Type':'application/json'}:{},body:method==='POST'?JSON.stringify(input??{}):undefined,
    signal:AbortSignal.any([signal,AbortSignal.timeout(60_000)])});
  const result=await response.json();
  if(!response.ok){
    if(result.code==='INVITE_REQUIRED'&&typeof window!=='undefined')window.dispatchEvent(new Event('flurbo:access-required'));
    throw Error(result.error||'Hybrid holdings unavailable. Refresh and retry.');
  }
  if(operation==='account'&&String(result.manifest?.pool).toLowerCase()!==pool)throw Error('Response belongs to a different collection.');
  return result;
}
