import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {configurePracticeCollections} from '../../../apps/web/server/practice-collections.mjs';
import {validateActivityDraft} from '../../../apps/web/shared/ethereum-activity.mjs';
// Explicit current bundle is mandatory: an old October-only bundle could drop Showcase.
const input=process.argv[2];
if(process.argv.length!==3||!input)throw Error('Supply the saved current complete collection bundle path.');
const root=new URL('../../../',import.meta.url);
const m=JSON.parse(await readFile(new URL('target/deployments/activity-test-testnet.json',root),'utf8'));
if(m.status!=='verified_pilot_snapshot'||m.publication?.mode!=='ethereum-activity'||m.publication.draft.title!=='Test')throw Error('Verify Test first');
validateActivityDraft(m.publication.draft);
const previous=JSON.parse(await readFile(resolve(input),'utf8'));
if(!Array.isArray(previous)||previous.some(row=>row.manifest?.pool===m.pool||row.label==='Test'))throw Error('Invalid bundle or Test already registered');
const entries=[...previous,{label:'Test',manifest:m}];
await configurePracticeCollections({env:{FLURBO_PRACTICE_COLLECTIONS_JSON:JSON.stringify(entries),FLURBO_PRACTICE_ACTIVE_POOL:m.pool},rpcUrl:'https://testnet-rpc.monad.xyz',command:async()=>null});
const destination=new URL('target/deployments/activity-test-collections.json',root);
await writeFile(destination,JSON.stringify(entries,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:'bundle_ready',collections:entries.map(row=>({label:row.label,pool:row.manifest.pool})),pool:m.pool,rulesHash:m.rulesHash,
  notice:'Verify this contains every currently registered collection before changing hosting or monitor settings. Nothing deployed.'},null,2));
