import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Owns one disposable local process. Never connects to a public chain, loads a
// keystore, changes a public manifest or takes over an existing development node.
const root=fileURLToPath(new URL('../../../',import.meta.url));
const windows=process.platform==='win32',suffix=windows?'.exe':'';
const forge=join(homedir(),'.foundry/bin/forge'+suffix),anvil=join(homedir(),'.foundry/bin/anvil'+suffix);
const bun=join(homedir(),'.bun/bin/bun'+suffix);
const solc=join(root,'target/tools/solc-0.8.28'+suffix);
for(const tool of [forge,anvil,bun,solc])await access(tool);
const output=join(root,'target/mock-testing');await mkdir(output,{recursive:true});
async function run(command,args,name){
  console.log('Running '+name+'...');
  let log='';
  const child=spawn(command,args,{cwd:root,windowsHide:true,env:{...process.env,FOUNDRY_PROFILE:'demo'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>{log+=b;});child.stderr.on('data',b=>{log+=b;});
  const timer=setTimeout(()=>child.kill(),180000);
  let code;
  try{code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});}finally{clearTimeout(timer);}
  await writeFile(join(output,name+'.log'),log);
  if(code!==0)throw new Error(name+' failed. See target/mock-testing/'+name+'.log');
  console.log(name+' passed.');
}
await run(forge,['test','--offline','--use',solc,'--match-path','contracts/test/Pilot*.t.sol'],'pilot-contracts');
// Check the exact loopback port before starting; never stop another process.
const probe=createServer();
await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(18549,'127.0.0.1',resolve);});
await new Promise(resolve=>probe.close(resolve));
let startupError=null,exited=false;
const node=spawn(anvil,['--host','127.0.0.1','--port','18549','--chain-id','10143','--silent'],{cwd:root,windowsHide:true,stdio:'ignore'});
node.once('error',error=>{startupError=error;});node.once('exit',()=>{exited=true;});
const stop=()=>{if(!exited)node.kill();};
const interrupt=()=>{stop();process.exitCode=130;};
process.once('SIGINT',interrupt);process.once('SIGTERM',interrupt);
try{
  let ready=false;
  for(let n=0;n<80;n++){
    if(startupError||exited)throw new Error('Disposable Anvil did not start');
    try{
      const response=await fetch('http://127.0.0.1:18549',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'web3_clientVersion',params:[]}),signal:AbortSignal.timeout(500)});
      ready=String((await response.json()).result).toLowerCase().includes('anvil');
    }catch{}
    if(ready)break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  if(!ready||exited)throw new Error('Disposable node unavailable');
  await run(bun,['workflows/cre/scripts/test-pilot-local.ts'],'pilot-lifecycle');
  await writeFile(join(output,'rehearsal.json'),JSON.stringify({status:'passed_local_rehearsal',checkedAt:new Date().toISOString(),publicTransactions:0,
    coverage:['approval','buy','sell','evidence','assertion','challenge','reviewer quorum','void timeout','delivery','redemption','bond withdrawal'],
    notice:'Disposable local EVM only. This does not establish hosted wallet or public settlement acceptance.'},null,2)+'\n');
  console.log('Settlement rehearsal passed. Results: target/mock-testing/rehearsal.json');
}finally{stop();process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',interrupt);}
