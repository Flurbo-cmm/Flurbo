import {readFile,writeFile} from 'node:fs/promises';
import {configurePracticeCollections} from '../../../apps/web/server/practice-collections.mjs';
const root=new URL('../../../',import.meta.url);
const showcase=JSON.parse(await readFile(new URL('target/deployments/showcase-v0-testnet.json',root),'utf8'));
if(showcase.status!=='verified_pilot_snapshot'||showcase.publication?.mode!=='ethereum-activity')throw Error('Verify Showcase before bundling');
// Start with the saved October bundle, preserving every previous registered entry.
const previous=JSON.parse(await readFile(new URL('target/deployments/october-demo-collections.json',root),'utf8'));
if(!Array.isArray(previous)||!previous.some(row=>row.manifest?.pool==='0x085b951ed24bbae44add2f9ff2b8198cd7517a07'))throw Error('October collection must remain registered');
const entries=[...previous,{label:'Showcase v0',manifest:showcase}];
await configurePracticeCollections({env:{FLURBO_PRACTICE_COLLECTIONS_JSON:JSON.stringify(entries),FLURBO_PRACTICE_ACTIVE_POOL:showcase.pool},rpcUrl:'https://testnet-rpc.monad.xyz',command:async()=>null});
await writeFile(new URL('target/deployments/showcase-v0-collections.json',root),JSON.stringify(entries));
console.log(JSON.stringify({status:'hosting_bundle_ready',file:'target/deployments/showcase-v0-collections.json',collections:entries.map(row=>({label:row.label,pool:row.manifest.pool})),activePool:showcase.pool,rulesHash:showcase.rulesHash,
  notice:'Public configuration only. Copy the collection bundle to Render and monitor Actions. Resolution still requires its explicit Showcase manifest, pool and rules hash. No deployment, email or transaction sent.'},null,2));
