import {mkdir,writeFile} from 'node:fs/promises';
import {prepareActivityTest} from '../src/showcase';
const root=new URL('../../../',import.meta.url),now=Math.floor(Date.now()/1000);
const selection=await Bun.file(new URL('config/pilot-alpha-selection.json',root)).json();
const destination=new URL('target/deployments/activity-test-prepared.json',root);
await mkdir(new URL('target/deployments/',root),{recursive:true});
let prepared;
if(await Bun.file(destination).exists()){
  const previous=await Bun.file(destination).json();
  prepared=prepareActivityTest(selection,now,previous.publication.draft.closesAt);
  if(prepared.configHash!==previous.configHash)throw Error('Existing Test differs; inspect artifacts before proceeding.');
}else{
  prepared=prepareActivityTest(selection,now);
  await writeFile(destination,JSON.stringify(prepared,null,2)+'\n',{flag:'wx'});
}
const close=prepared.publication.draft.closesAt;
console.log(JSON.stringify({status:prepared.status,title:'Test',tradeCloses:new Date(close*1000).toISOString(),
  assertionsOpen:new Date((close+1920)*1000).toISOString(),earliestSettlement:new Date((close+5520)*1000).toISOString(),
  questions:prepared.publication.draft.events.map(e=>e.question),
  notice:'Ninety-minute trading window from preparation. Settlement requires later scheduled transactions and one-hour challenges. Nothing deployed.'},null,2));
