import { mkdir,writeFile } from 'node:fs/promises';
import { prepareOctoberDemo,OCTOBER_CLOSE } from '../src/october-demo';
const root=new URL('../../../',import.meta.url);
const selection=await Bun.file(new URL('config/pilot-alpha-selection.json',root)).json();
const prepared=prepareOctoberDemo(selection,Math.floor(Date.now()/1000));
await mkdir(new URL('target/deployments/',root),{recursive:true});
const destination=new URL('target/deployments/october-demo-prepared.json',root);
try{await writeFile(destination,JSON.stringify(prepared,null,2)+'\n',{flag:'wx'});}
catch(error){
  if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
  const previous=await Bun.file(destination).json();
  if(previous.configHash!==prepared.configHash||previous.draftHash!==prepared.draftHash)throw Error('Existing October preparation differs. Review it before changing deployment artifacts.');
}
console.log(JSON.stringify({status:prepared.status,tradeCloses:new Date(OCTOBER_CLOSE*1000).toISOString(),
  assertionsOpen:new Date((OCTOBER_CLOSE+120)*1000).toISOString(),assertionDeadline:new Date((OCTOBER_CLOSE+3720)*1000).toISOString(),
  subsidyTestAusd:'27.725888',notice:'Separate October preparation. No deployment occurred. Original pool artifacts are unchanged.'},null,2));
