import { configureCollection } from './pilot-config.mjs';
import { MAX_LISTED_COLLECTIONS, listedCollections, loadRegistry, registryEnabled } from './collection-registry.mjs';

export const practiceNamespace = pool => {
  if (typeof pool !== 'string' || !/^0x[0-9a-f]{40}$/.test(pool)) throw Error('Invalid practice pool');
  return `practice-${pool.slice(2)}`;
};

// Collections come from the committed registry (FLURBO_COLLECTIONS_SOURCE=registry) or, as before, from the
// FLURBO_PRACTICE_COLLECTIONS_JSON bundle with FLURBO_PRACTICE_ACTIVE_POOL as the featured pool.
export async function collectionRows({env=process.env,registry=null}={}) {
  if(registryEnabled(env)){
    const r=registry||await loadRegistry();
    return {rows:listedCollections(r).map(({label,manifest})=>({label,manifest})),featured:r.featured??undefined};
  }
  const rows=env.FLURBO_PRACTICE_COLLECTIONS_JSON===undefined?[]:JSON.parse(env.FLURBO_PRACTICE_COLLECTIONS_JSON);
  return {rows,featured:env.FLURBO_PRACTICE_ACTIVE_POOL};
}

// Every practice collection is registered explicitly. Each one is addressed only by its
// pool-derived namespace, so removing a collection never repoints an old link to another pool.
export async function configurePracticeCollections({env=process.env,rpcUrl,command,registry=null}) {
  const {rows:extras,featured:chosen}=await collectionRows({env,registry});
  if(!Array.isArray(extras)||extras.length>MAX_LISTED_COLLECTIONS)throw Error(`At most ${MAX_LISTED_COLLECTIONS} practice collections are supported`);
  const services=new Map(),entries=[],pools=new Set(),resolvers=new Set();
  for(const row of extras){
    if(!row||Object.keys(row).sort().join(',')!=='label,manifest'||typeof row.label!=='string'||! /^[A-Za-z0-9][A-Za-z0-9 ()-]{2,59}$/.test(row.label))throw Error('Invalid practice collection entry');
    const service=await configureCollection({manifest:row.manifest,rpcUrl,command});
    const {manifest}=service,namespace=practiceNamespace(manifest.pool);
    if(pools.has(manifest.pool)||resolvers.has(manifest.resolver)||entries.some(e=>e.label===row.label))throw Error('Duplicate practice collection');
    pools.add(manifest.pool);resolvers.add(manifest.resolver);services.set(namespace,service);
    entries.push({namespace,label:row.label,pool:manifest.pool,closesAt:manifest.publication.draft.closesAt});
  }
  const featured=chosen===undefined?entries[0]?.pool:chosen;
  const selected=entries.find(e=>e.pool===featured);
  if(entries.length&&!selected)throw Error('Featured practice pool must be a registered collection');
  return {services,catalog:{schema:'flurbo.practice-collections.v1',active:selected?.namespace??null,collections:entries}};
}
