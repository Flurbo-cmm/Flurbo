import {mkdir,writeFile} from 'node:fs/promises';
import {prepareShowcase} from '../src/showcase';
const root=new URL('../../../',import.meta.url),now=Math.floor(Date.now()/1000);
const selection=await Bun.file(new URL('config/pilot-alpha-selection.json',root)).json();
const destination=new URL('target/deployments/showcase-v0-prepared.json',root);
await mkdir(new URL('target/deployments/',root),{recursive:true});
// Re-running never changes committed dates. Do not prepare until ready to deploy.
let prepared;
if(await Bun.file(destination).exists()){
  const previous=await Bun.file(destination).json();
  prepared=prepareShowcase(selection,now,previous.publication.draft.closesAt);
  if(prepared.configHash!==previous.configHash)throw Error('Existing showcase differs; inspect artifacts before proceeding.');
}else{
  prepared=prepareShowcase(selection,now);
  await writeFile(destination,JSON.stringify(prepared,null,2)+'\n',{flag:'wx'});
}
const close=prepared.publication.draft.closesAt;
console.log(JSON.stringify({status:prepared.status,title:'Showcase v0',tradeCloses:new Date(close*1000).toISOString(),
  ethereumTargetTime:new Date((close+120)*1000).toISOString(),assertionsOpen:new Date((close+1920)*1000).toISOString(),
  earliestSettlement:new Date((close+5520)*1000).toISOString(),assertionDeadline:new Date((close+5520)*1000).toISOString(),
  questions:prepared.publication.draft.events.map(e=>e.question),notice:'Four trading hours from preparation. One-hour challenges follow assertions; delays and disputes extend settlement. Nothing deployed.'},null,2));
