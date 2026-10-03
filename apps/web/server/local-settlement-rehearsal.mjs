import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,readFile,rename,unlink,link,lstat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {notifyPool} from '../scripts/notify-settlement.mjs';
import {runResolution,resolutionFailure} from '../scripts/run-resolution.mjs';
import {pilotRpc} from './pilot.mjs';
import {settlementLease} from './settlement-store.mjs';
import {settlementPublicOrigin} from './settlement-persistence.mjs';

const address=value=>typeof value==='string'&&/^0x[0-9a-f]{40}$/.test(value)&&!/^0x0{40}$/.test(value);
const hash=value=>typeof value==='string'&&/^0x[0-9a-f]{64}$/.test(value);
export function rehearsalConfig(input){
  const keys=['schema','manifestPath','stateDirectory','signerAddress','pool','rulesHash','rpcUrl','evidenceOrigin','port','intervalSeconds'];
  if(!input||Object.keys(input).some(k=>!keys.includes(k))||input.schema!=='flurbo.local-settlement-rehearsal.v1'
    ||!address(input.signerAddress)||!address(input.pool)||!hash(input.rulesHash)
    ||typeof input.manifestPath!=='string'||!input.manifestPath||typeof input.stateDirectory!=='string'||!input.stateDirectory)
    throw Error('Explicit public rehearsal configuration required');
  const rpcUrl=input.rpcUrl||'https://testnet-rpc.monad.xyz';
  pilotRpc(rpcUrl); // Uses the production testnet-only allowlist, without sending a request.
  const port=input.port??18867,intervalSeconds=input.intervalSeconds??60;
  if(!Number.isSafeInteger(port)||port<1024||port>65535||!Number.isSafeInteger(intervalSeconds)||intervalSeconds<15||intervalSeconds>120)
    throw Error('Invalid local rehearsal port or polling interval');
  const evidenceOrigin=settlementPublicOrigin(input.evidenceOrigin);
  return {...input,rpcUrl,port,intervalSeconds,evidenceOrigin};
}

export function rehearsalEnvironment(config,manifest,{execute=false,privateKey}={}){
  config=rehearsalConfig(config);
  if(typeof execute!=='boolean')throw Error('Execution mode must be explicit boolean');
  if(manifest?.chainId!==10143||manifest.pool!==config.pool||manifest.rulesHash!==config.rulesHash
    ||manifest.publication?.mode!=='deterministic-source-v1')throw Error('Only the explicitly selected deterministic test collection may run');
  const publication=manifest.publication;
  if(!Array.isArray(publication.reviewers)||[manifest.pool,manifest.resolver,publication.creator,...publication.reviewers.map(row=>row?.address)]
    .some(value=>typeof value==='string'&&value.toLowerCase()===config.signerAddress))throw Error('Use a separate non-reviewer rehearsal signer');
  if(execute&&(typeof privateKey!=='string'||!privateKey))throw Error('A dedicated rehearsal signing key is required');
  // Never inherit the production pool, Redis credentials, finishing bundle or signer.
  return {FLURBO_RESOLUTION_MANIFEST_JSON:JSON.stringify(manifest),FLURBO_RESOLUTION_POOL:config.pool,
    FLURBO_RESOLUTION_RULES_HASH:config.rulesHash,FLURBO_RESOLUTION_SIGNER_ADDRESS:config.signerAddress,
    FLURBO_ALCHEMY_TESTNET_RPC_URL:config.rpcUrl,FLURBO_RESOLUTION_EXECUTE:String(execute),
    FLURBO_RESOLUTION_PROPOSALS:'true',FLURBO_RESOLUTION_SOURCE_MODE:'deterministic-source-v1',FLURBO_RESOLUTION_EVIDENCE_ORIGIN:config.evidenceOrigin,
    ...(execute?{FLURBO_RESOLUTION_PRIVATE_KEY:privateKey}:{})};
}

export async function writeRehearsalJson(path,value){
  const body=JSON.stringify(value,null,2)+'\n';
  const temporary=path+'.'+randomUUID()+'.tmp';
  try{
    const file=await open(temporary,'wx',0o600);
    try{await file.writeFile(body);await file.sync();}finally{await file.close();}
    await rename(temporary,path);
  }finally{await unlink(temporary).catch(()=>{});}
}

// Local alert delivery is an actual durable, readable outbox. It is deliberately
// labelled local-file, never represented as email acceptance or human review.
export async function localAlertSink(directory){
  const folder=resolve(directory,'alerts');await mkdir(folder,{recursive:true});
  return async item=>{
    if(!/^flurbo-[0-9a-f-]{36}$/.test(item?.key)||typeof item.body?.text!=='string'||item.body.text.length>50000)
      throw Error('Invalid local notification');
    const body=JSON.stringify({schema:'flurbo.local-settlement-alert.v1',channel:'local-file',key:item.key,body:item.body});
    if(Buffer.byteLength(body)>200000)throw Error('Local notification too large');
    const digest=createHash('sha256').update(body).digest('hex'),path=resolve(folder,item.key+'.json');
    const temporary=path+'.'+randomUUID()+'.tmp';
    try{
      const file=await open(temporary,'wx',0o600);
      try{await file.writeFile(body);await file.sync();}finally{await file.close();}
      // Publishing a fully flushed hard link is atomic and refuses replacement.
      // Concurrent retries can only read the complete previous payload.
      try{await link(temporary,path);}catch(error){if(error.code!=='EEXIST')throw error;}
    }finally{await unlink(temporary).catch(()=>{});}
    const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Invalid local notification path');
    if(await readFile(path,'utf8')!==body)throw Error('Local notification persistence or identity mismatch');
    return 'local-file-'+digest;
  };
}

export function createRehearsalCycle({config,manifest,command,workerDependencies={},privateKey,execute=false,send,
  now=()=>Math.floor(Date.now()/1000),inspect,run=runResolution,rpc=pilotRpc(config.rpcUrl)}){
  const env=rehearsalEnvironment(config,manifest,{execute,privateKey});
  const notificationConfig={from:'monitor@rehearsal.invalid',to:['operator@rehearsal.invalid']};
  return async()=>{
    const lease=await settlementLease(command,'local-rehearsal-cycle:'+config.signerAddress);
    try{
      const monitoring=await notifyPool({manifest,command,rpc,config:notificationConfig,send,now,...(inspect?{inspect}:{})});
      const report={schema:'flurbo.local-rehearsal-cycle.v1',checkedAt:now(),pool:manifest.pool,execute,
        monitoring:{status:monitoring.status,channel:'local-file',acceptedAlerts:monitoring.acceptedEmails,pendingAlerts:monitoring.pendingEmails},
        worker:null,notice:'Local scheduler on public Monad testnet. No hosted cron, email delivery or production reliability claim.'};
      if(monitoring.status==='check_failed'||monitoring.pendingEmails){report.worker={status:'monitoring-blocked'};return report;}
      try{report.worker=await run(env,{...workerDependencies,command});}
      catch(error){report.worker=resolutionFailure(error);}
      return report;
    }finally{await lease.release();}
  };
}
