import { appFetch } from './platform-fetch';
import { isPracticeNamespace, type PilotNamespace } from './pilot';

export type PracticeCatalog={schema:'flurbo.practice-collections.v1';active:PilotNamespace|null;collections:{namespace:PilotNamespace;label:string;pool:string;closesAt:number}[]};
export async function loadPracticeCollections(signal:AbortSignal):Promise<PracticeCatalog>{
  const response=await appFetch('/api/practice-collections',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(20_000)])});
  if(!response.ok)throw Error('Market collections could not be loaded. Please retry.');
  const data=await response.json() as PracticeCatalog;
  if(data.schema!=='flurbo.practice-collections.v1'||!Array.isArray(data.collections)||data.collections.length>24
    ||data.collections.some(row=>!isPracticeNamespace(row.namespace)||!/^0x[0-9a-f]{40}$/.test(row.pool)||typeof row.label!=='string'||!Number.isSafeInteger(row.closesAt)
      ||row.namespace!==`practice-${row.pool.slice(2)}`)
    ||new Set(data.collections.map(row=>row.namespace)).size!==data.collections.length
    ||(data.active===null?data.collections.length>0:!data.collections.some(row=>row.namespace===data.active)))throw Error('Invalid market collection configuration.');
  return data;
}
