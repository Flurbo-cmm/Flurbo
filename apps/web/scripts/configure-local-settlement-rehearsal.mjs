import {readFile,open,link,lstat,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {rehearsalConfig,rehearsalEnvironment} from '../server/local-settlement-rehearsal.mjs';
import {validateSettlementManifest} from '../server/settlement-publication.mjs';
import {pilotRpc,pilotService} from '../server/pilot.mjs';
import {localStateDirectory} from './run-local-settlement-rehearsal.mjs';

const root=fileURLToPath(new URL('../../../',import.meta.url));
export async function persistLocalRehearsalConfig(path,config){
  config=rehearsalConfig(config);
  const temporary=path+'.'+randomUUID()+'.tmp';
  try{
    const file=await open(temporary,'wx',0o600);
    try{await file.writeFile(JSON.stringify(config,null,2)+'\n');await file.sync();}finally{await file.close();}
    // Publish only a complete file, without ever replacing a previous run's config.
    try{await link(temporary,path);}catch(error){if(error.code!=='EEXIST')throw error;}
    const stat=await lstat(path);
    if(!stat.isFile()||stat.isSymbolicLink())throw Error('Invalid rehearsal configuration path');
    const existing=rehearsalConfig(JSON.parse(await readFile(path,'utf8')));
    if(!isDeepStrictEqual(existing,config))throw Error('Existing rehearsal configuration differs; preserve it and inspect pending transactions');
  }finally{await unlink(temporary).catch(()=>{});}
}
export async function configureLocalRehearsal(bootstrapPath,{rpc,read=readFile,persist=persistLocalRehearsalConfig}={}){
  const bootstrap=JSON.parse(await read(resolve(root,bootstrapPath),'utf8'));
  if(bootstrap.schema!=='flurbo.rehearsal-bootstrap.v1')throw Error('Explicit rehearsal bootstrap required');
  const manifestPath='target/deployments/deterministic-test-testnet.json';
  const manifest=JSON.parse(await read(resolve(root,manifestPath),'utf8'));
  validateSettlementManifest(manifest);
  const config=rehearsalConfig({schema:'flurbo.local-settlement-rehearsal.v1',manifestPath,stateDirectory:bootstrap.stateDirectory,
    signerAddress:bootstrap.signerAddress,pool:manifest.pool,rulesHash:manifest.rulesHash,
    evidenceOrigin:bootstrap.evidenceOrigin,port:bootstrap.port,intervalSeconds:bootstrap.intervalSeconds});
  rehearsalEnvironment(config,manifest); // Exact pool, mode, rules and dedicated signer boundaries.
  const state=await pilotService({manifest,rpc:rpc||pilotRpc(config.rpcUrl)}).status();
  if(state.delivered)throw Error('This collection is already delivered; preserve its state instead of starting another rehearsal');
  const directory=localStateDirectory(config.stateDirectory),path=resolve(directory,'config.json');
  await persist(path,config);
  return {status:'configured',path,pool:config.pool,rulesHash:config.rulesHash,signer:config.signerAddress,
    chain:'public Monad testnet',website:`http://localhost:${config.port}/markets`,
    notice:'No transaction sent. Start the local website and monitor/worker. Public evidence availability and actual unattended settlement still require verification.'};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==3){console.error('Supply the explicit public bootstrap path.');process.exitCode=1;}
  else configureLocalRehearsal(process.argv[2]).then(report=>console.log(JSON.stringify(report,null,2))).catch(()=>{
    console.error('Local configuration refused. Check verified deployment, dedicated signer, evidence origin and existing state. No transaction sent.');process.exitCode=1;
  });
}
