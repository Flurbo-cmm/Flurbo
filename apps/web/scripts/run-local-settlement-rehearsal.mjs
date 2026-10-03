import {readFile,mkdir,open} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,relative,isAbsolute} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {rehearsalConfig,rehearsalEnvironment,createRehearsalCycle,localAlertSink,writeRehearsalJson} from '../server/local-settlement-rehearsal.mjs';
import {createLocalSettlementCommand} from '../server/local-settlement-command.mjs';
import {createSettlementStores} from '../server/settlement-persistence.mjs';
import {pilotEvidence} from '../server/pilot.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
export function localStateDirectory(value){
  const base=resolve(root,'target/local-settlement-rehearsal'),path=resolve(root,value),child=relative(base,path);
  if(!child||child.startsWith('..')||isAbsolute(child))throw Error('Use a separate directory under target/local-settlement-rehearsal');
  return path;
}
export async function loadLocalRehearsal(path){
  const raw=await readFile(resolve(root,path),'utf8');
  if(Buffer.byteLength(raw)>100000)throw Error('Configuration too large');
  const config=rehearsalConfig(JSON.parse(raw)),directory=localStateDirectory(config.stateDirectory);
  const body=await readFile(resolve(root,config.manifestPath),'utf8');
  if(Buffer.byteLength(body)>2_000_000)throw Error('Manifest too large');
  const manifest=JSON.parse(body);
  rehearsalEnvironment(config,manifest);
  return {config,manifest,directory};
}
export async function runLocalRehearsal({configPath,execute=false,once=false,signal,output=console.log,privateKey=process.env.FLURBO_REHEARSAL_PRIVATE_KEY}={}){
  const {config,manifest,directory}=await loadLocalRehearsal(configPath);
  await mkdir(directory,{recursive:true});
  const command=await createLocalSettlementCommand({directory:resolve(directory,'store')});
  const stores=createSettlementStores({command,origin:config.evidenceOrigin});
  const archive=pilotEvidence(command,config.evidenceOrigin),send=await localAlertSink(directory);
  const cycle=createRehearsalCycle({config,manifest,command,privateKey,execute,send,
    workerDependencies:{settlementStores:stores,archive}});
  const log=await open(resolve(directory,'cycles.jsonl'),'a',0o600);
  try{
    do{
      let result;
      try{result=await cycle();}
      catch{result={schema:'flurbo.local-rehearsal-cycle.v1',checkedAt:Math.floor(Date.now()/1000),pool:config.pool,execute,
        worker:{status:'local-rehearsal-blocked'},notice:'Inspect configuration, monitoring, storage and pending transactions. Sensitive values withheld.'};}
      await log.write(JSON.stringify(result)+'\n');await log.sync();
      await writeRehearsalJson(resolve(directory,'latest.json'),result);output(JSON.stringify(result));
      if(once||result.worker?.status==='complete'||signal?.aborted)return result;
      try{await delay(config.intervalSeconds*1000,undefined,{signal});}catch(error){if(error.name!=='AbortError')throw error;}
    }while(!signal?.aborted);
  }finally{await log.close();}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const args=process.argv.slice(2),path=args[0];
  if(!path||args.slice(1).some(v=>!['--execute','--once'].includes(v))||new Set(args.slice(1)).size!==args.length-1){
    console.error('Use run-local-settlement-rehearsal.mjs <config.json> [--execute] [--once]');process.exitCode=1;
  }else{
    const controller=new AbortController();
    for(const event of ['SIGINT','SIGTERM'])process.once(event,()=>controller.abort());
    runLocalRehearsal({configPath:path,execute:args.includes('--execute'),once:args.includes('--once'),signal:controller.signal})
      .catch(()=>{console.error('Local rehearsal could not start. Check the explicit test configuration; secrets withheld.');process.exitCode=1;});
  }
}
