import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createPublicClient,http,recoverTransactionAddress} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {monadTestnet} from 'viem/chains';
import {pilotService,pilotRpc,pilotEvidence} from '../server/pilot.mjs';
import {redisCommand} from '../server/redis-session.mjs';
import {evidenceAssistant} from '../server/evidence-assistant.mjs';
import {resolutionTick,resolutionRound} from '../server/resolution-worker.mjs';
import {proposerHoldings as readProposerHoldings} from '../server/proposer-guard.mjs';
import {activityEvidence} from '../server/ethereum-activity.mjs';
import {validateActivityDraft} from '../shared/ethereum-activity.mjs';
import {DETERMINISTIC_MODE,validateSettlementManifest} from '../server/settlement-publication.mjs';
import {deterministicEvidence} from '../server/deterministic-evidence.mjs';
import {createSettlementStores,settlementPublicOrigin} from '../server/settlement-persistence.mjs';
import {readFile} from 'node:fs/promises';
import {heldPools,loadRegistry,registryEnabled} from '../server/collection-registry.mjs';

const diagnosticMessages={
  CONFIGURATION_INVALID:'Check the manifest, pool, rules hash, execution mode and public signer settings.',
  BOT_KEY_MISSING:'Add FLURBO_RESOLUTION_PRIVATE_KEY as a repository Actions secret for the dedicated bot.',
  BOT_KEY_INVALID:'The bot secret must contain one 64-digit hexadecimal private key, optionally prefixed with 0x. Do not use a seed phrase or keystore JSON.',
  BOT_KEY_MISMATCH:'The key does not belong to FLURBO_RESOLUTION_SIGNER_ADDRESS. Use the dedicated bot wallet key.',
  RPC_READ_FAILED:'The testnet RPC read failed or was rejected. Check provider availability and quota.',
  DURABLE_STATE_FAILED:'The Redis operation failed. Check its availability and the worker repository secrets.',
  WORKER_CHECK_FAILED:'A worker policy, deployment, monitoring or pending transaction check failed. Preserve the journal and inspect the latest monitor run.',
};
class ResolutionDiagnostic extends Error{
  constructor(code){super(diagnosticMessages[code]);this.code=code;}
}
export function resolutionFailure(error){
  const code=error instanceof ResolutionDiagnostic?error.code:'WORKER_CHECK_FAILED';
  return {status:'resolution_stopped',code,message:diagnosticMessages[code]+' Sensitive values withheld. No automatic replacement transaction.'};
}
export function resolutionSigner(value,owner){
  if(typeof value!=='string'||!value.trim())throw new ResolutionDiagnostic('BOT_KEY_MISSING');
  const hex=value.trim().replace(/^0x/i,'');
  if(!/^[0-9a-fA-F]{64}$/.test(hex))throw new ResolutionDiagnostic('BOT_KEY_INVALID');
  let account;
  try{account=privateKeyToAccount(`0x${hex}`);}catch{throw new ResolutionDiagnostic('BOT_KEY_INVALID');}
  if(account.address.toLowerCase()!==owner.toLowerCase())throw new ResolutionDiagnostic('BOT_KEY_MISMATCH');
  return account;
}
// The RPC reader's Multicall batch is kept, so a pool status read stays one batched call rather than many.
const guarded=(code,fn)=>{
  const wrap=f=>async(...args)=>{try{return await f(...args);}catch{throw new ResolutionDiagnostic(code);}};
  const g=wrap(fn);if(typeof fn.readBatch==='function')g.readBatch=wrap(fn.readBatch);return g;
};

// Opt-in multi-pool finishing. Both the bundle and an exact pool:rulesHash allowlist are required
// and must match one to one, so editing the secret bundle alone cannot add a pool.
export function finishingManifests(env,primary){
  const bundle=env.FLURBO_RESOLUTION_COLLECTIONS_JSON,list=env.FLURBO_RESOLUTION_FINISH_ALLOWLIST;
  if(!bundle&&!list)return null;
  if(!bundle||!list)throw Error('Finishing pools need both a manifest bundle and an allowlist');
  const allowed=list.split(',').map(v=>v.trim().toLowerCase()).filter(Boolean);
  if(!allowed.length||allowed.some(v=>!/^0x[0-9a-f]{40}:0x[0-9a-f]{64}$/.test(v))||new Set(allowed).size!==allowed.length)throw Error('Invalid finishing allowlist');
  const rows=JSON.parse(bundle);
  if(!Array.isArray(rows))throw Error('Invalid finishing bundle');
  const primaryPool=primary.pool.toLowerCase();
  // The proposing pool is configured separately; a bundle copy of it is ignored, not doubled.
  const manifests=rows.map(row=>row?.manifest||row).filter(m=>String(m?.pool).toLowerCase()!==primaryPool);
  const keys=manifests.map(m=>(m?.pool+':'+m?.rulesHash).toLowerCase());
  const expected=allowed.filter(k=>!k.startsWith(primaryPool+':'));
  if(new Set(keys).size!==keys.length||keys.length!==expected.length||keys.some(k=>!expected.includes(k)))throw Error('Finishing bundle must match the allowlist exactly');
  for(const m of manifests){
    if(m.chainId!==10143)throw Error('Finishing pools must be Monad testnet');
    pilotService({manifest:m,rpc:async()=>{throw Error('No read during configuration');}});
    if(m.publication?.mode==='ethereum-activity')validateActivityDraft(m.publication.draft);
    if(m.publication?.mode===DETERMINISTIC_MODE)validateSettlementManifest(m);
  }
  return manifests;
}

// Proposals are off unless explicitly "true"; unset (or GitHub's empty string for an unset variable) means off.
export function proposalMode(env){
  const value=env.FLURBO_RESOLUTION_PROPOSALS??'';
  if(!['','true','false'].includes(value))throw Error('Invalid proposal mode');
  return value==='true';
}

// Release questions: the YES decision is the deterministic assessRelease() check of the official GitHub
// release record, never a model. An AI explanation is attached only when one is configured and succeeds;
// its absence never blocks an assertion. NO is never inferred: a missing release is not proof of NO.
export async function legacyReleaseEvidence({manifest,event,env,archive,owner,assistant}){
  const aiConfigured=env.FLURBO_EVIDENCE_FREE_TIER_CONFIRMED==='true'&&!!env.FLURBO_EVIDENCE_GEMINI_KEY;
  const report=await assistant.review(event.id,aiConfigured);
  if(report.assessment.recommendation!=='YES')return null;
  const facts=report.assessment.facts,explained=report.ai.status==='generated'&&report.ai.explanation?.summary?.length>=20;
  const statement=explained?report.ai.explanation.summary
    :`Automatic YES from the official GitHub release record: ${facts.tag} (release ${facts.releaseId}) was published as a stable release at ${facts.publishedAt}, inside the committed observation window. Checked by rule github-stable-release-publication.v1; the archived API response is attached.`;
  const saved=await archive.put({eventId:event.id,outcome:2,statement,sourceURL:report.evidence[0].endpoint,
    attachment:JSON.stringify({reportHash:report.reportHash,assessment:report.assessment,...(explained?{ai:report.ai}:{}),sourceHash:report.evidence[0].payloadHash})},owner,manifest.draftHash);
  return {...saved,outcome:2};
}

// Registry mode: every registered pool except those set to "off", plus the release pilot under the registry's
// pilotSettlement. "auto" pools read their committed sources and propose; held pools (FLURBO_RESOLUTION_HOLD)
// keep collecting evidence but do not assert. Every pool can still be finalized after its deadlines and delivered.
export function registryPlan({registry,base,proposals,hold}){
  const rows=[...(base?[{manifest:base,settlement:registry.pilotSettlement}]:[]),
    ...registry.collections.map(row=>({manifest:row.manifest,settlement:row.settlement}))].filter(row=>row.settlement!=='off');
  const pools=rows.map(row=>row.manifest.pool.toLowerCase());
  if(new Set(pools).size!==pools.length)throw Error('A pool is registered twice');
  if(rows.some(row=>row.manifest.chainId!==10143))throw Error('Registered pools must be Monad testnet');
  const known=new Set([...(base?[base.pool.toLowerCase()]:[]),...registry.collections.map(row=>row.manifest.pool.toLowerCase())]);
  for(const pool of hold)if(!known.has(pool))throw Error('FLURBO_RESOLUTION_HOLD names a pool that is not registered');
  return rows.map(row=>{
    const auto=proposals&&row.settlement==='auto';
    return {...row,collects:auto,proposing:auto&&!hold.has(row.manifest.pool.toLowerCase())};
  });
}

// Pools the bot's monitor read within the last ten minutes with nothing due for at least five more. The worker
// skips their chain reads; a pool with a pending transaction is always reconciled first.
export function idlePools(schedule,at){
  const idle=new Set();
  for(const [pool,seen] of schedule||[]){
    if(!Number.isSafeInteger(seen?.checkedAt)||at-seen.checkedAt>600||seen.checkedAt>at)continue;
    if(seen.nextDueAt==='none'||(Number.isSafeInteger(seen.nextDueAt)&&seen.nextDueAt-at>300))idle.add(pool);
  }
  return idle;
}

// Source collection for each collecting pool, only while one of its rules can still use an observation: snapshot
// rules from their window opening, until the assertion deadline. One pool's failure never stops the others.
async function collectSources(pools,at){
  const out=[];
  for(const p of pools){
    if(!p.collects||!p.sources)continue;
    const rules=p.manifest.publication.settlementRules||[];
    if(!rules.some(r=>(r.vintage!=='first-observed-snapshot'||at>=r.timing.scheduledAt)&&at<r.timing.observationEndsAt+r.timing.assertionPeriod))continue;
    try{
      const results=(await p.sources.collect(await p.service.status())).filter(r=>r.status!=='waiting-for-snapshot-window');
      if(results.length)out.push({pool:p.manifest.pool,results});
    }catch{out.push({pool:p.manifest.pool,status:'collect-failed'});}
  }
  return out;
}

async function basePilotManifest(env){
  if(env.FLURBO_PILOT_DISABLED==='true')return null;
  const base=JSON.parse(env.FLURBO_PILOT_MANIFEST_JSON??await readFile(new URL('../../../config/pilot-testnet.json',import.meta.url),'utf8'));
  if(['rehearsal','ethereum-activity',DETERMINISTIC_MODE].includes(base.publication?.mode))throw Error('Configure the release pilot pool');
  return base;
}

export async function runResolution(env=process.env,deps={}){
  let configured=false;
  try{
  const registry=registryEnabled(env)?(deps.registry||await loadRegistry()):null;
  const manifest=registry?null:JSON.parse(env.FLURBO_RESOLUTION_MANIFEST_JSON||'null');
  const deterministic=manifest?.publication?.mode===DETERMINISTIC_MODE;
  if(!registry){
    if(!manifest||manifest.pool!==env.FLURBO_RESOLUTION_POOL||manifest.rulesHash!==env.FLURBO_RESOLUTION_RULES_HASH)throw Error('Explicit pool and immutable rules allowlist required');
    if(manifest.publication?.mode==='ethereum-activity')validateActivityDraft(manifest.publication.draft);
    if(deterministic){
      validateSettlementManifest(manifest);
      if(env.FLURBO_RESOLUTION_SOURCE_MODE!==DETERMINISTIC_MODE)throw Error('Explicit deterministic worker source mode required');
      settlementPublicOrigin(env.FLURBO_RESOLUTION_EVIDENCE_ORIGIN);
    }else if(env.FLURBO_RESOLUTION_SOURCE_MODE&&env.FLURBO_RESOLUTION_SOURCE_MODE!=='legacy')throw Error('Source mode and immutable publication differ');
  }
  const now=deps.now||(()=>Math.floor(Date.now()/1000));
  const endpoint=env.FLURBO_ALCHEMY_TESTNET_RPC_URL||'https://testnet-rpc.monad.xyz';
  const rpc=guarded('RPC_READ_FAILED',deps.rpc||pilotRpc(endpoint)),service=registry?null:deps.service||pilotService({manifest,rpc}),command=guarded('DURABLE_STATE_FAILED',deps.command||redisCommand(env));
  const enabled=env.FLURBO_RESOLUTION_EXECUTE==='true';
  if(!['true','false'].includes(env.FLURBO_RESOLUTION_EXECUTE||'false'))throw Error('Invalid execution mode');
  const owner=env.FLURBO_RESOLUTION_SIGNER_ADDRESS?.toLowerCase();
  if(!/^0x[0-9a-f]{40}$/.test(owner||''))throw Error('Dedicated public signer address required');
  let account=null;
  if(enabled)account=resolutionSigner(env.FLURBO_RESOLUTION_PRIVATE_KEY,owner);
  const client=deps.client||createPublicClient({chain:monadTestnet,transport:http(endpoint,{retryCount:0,timeout:15000})});
  const transport=deps.transport||{
    async receipt(hash){
      const r=await client.request({method:'eth_getTransactionReceipt',params:[hash]});
      if(!r)return null;
      if(r.transactionHash!==hash||!['0x0','0x1'].includes(r.status)||!r.blockHash||!r.blockNumber)throw Error('Invalid receipt');
      const head=await client.getBlockNumber(),block=await client.getBlock({blockNumber:BigInt(r.blockNumber)});
      if(block.hash!==r.blockHash)throw Error('Receipt block changed');
      return {confirmed:head>=BigInt(r.blockNumber)+2n,success:r.status==='0x1'};
    },
    async retryStatus(hash,address){
      if(await client.getChainId()!==10143)throw Error('Wrong chain');
      const known=await client.request({method:'eth_getTransactionByHash',params:[hash]});
      if(known&&known.hash?.toLowerCase()!==hash.toLowerCase())throw Error('Pending hash response mismatch');
      return {known:!!known,latestNonce:await client.getTransactionCount({address,blockTag:'latest'}),
        pendingNonce:await client.getTransactionCount({address,blockTag:'pending'})};
    },
    async sign(review){
      if(!account||!enabled)throw Error('Execution disabled');
      if(await client.getChainId()!==10143)throw Error('Wrong chain');
      const nonce=await client.getTransactionCount({address:owner,blockTag:'pending'});
      if(nonce!==await client.getTransactionCount({address:owner,blockTag:'latest'}))throw Error('Untracked signer transaction pending');
      const gas=BigInt(review.gasLimit),gasPrice=BigInt(review.gasPrice);
      if(await client.getBalance({address:owner})<gas*gasPrice)throw Error('Fund dedicated signer gas');
      const raw=await account.signTransaction({type:'legacy',chainId:10143,nonce,to:review.transaction.to,data:review.transaction.data,value:0n,gas,gasPrice});
      if((await recoverTransactionAddress({serializedTransaction:raw})).toLowerCase()!==owner)throw Error('Signed sender mismatch');
      return raw;
    },
    async broadcast(raw){if(!enabled)throw Error('Execution disabled');return client.sendRawTransaction({serializedTransaction:raw});}
  };
  const origin=env.FLURBO_RESOLUTION_EVIDENCE_ORIGIN||'https://flurbo.singu.online';
  if(env.FLURBO_RESOLUTION_EVIDENCE_ORIGIN)settlementPublicOrigin(origin);
  const archive=deps.archive||pilotEvidence(command,origin,()=>now()*1000);
  const stores=()=>deps.settlementStores||createSettlementStores({command,origin,now});
  const sourcesFor=m=>deterministicEvidence({manifest:m,owner,command,archive,origin,now,...stores(),request:deps.request||fetch,retainedCache:deps.retainedCaptures});
  const sources=deterministic?sourcesFor(manifest):null;
  const evidenceFor=(manifest,source=sources)=>async event=>{
    const q=manifest.publication.draft.events[event];
    if(manifest.publication.mode===DETERMINISTIC_MODE)return source.proposal(event);
    if(manifest.publication.mode==='ethereum-activity'){
      try{return await (await activityEvidence(manifest,command,archive,owner))(event);}catch{return null;}
    }
    if(manifest.publication.mode==='rehearsal'){
      const letter=event===0?'A':event===3?'D':null;
      if(!letter||q.source.recordId!==`flurbo-rehearsal.v1:${event}`||q.source.referenceUrl!=='https://flurbo.singu.online/rehearsal-rules'
        ||q.source.selectionRule!==`Scripted fixture ${letter} is YES. Exercise an unchallenged assertion.`)return null;
      const saved=await archive.put({eventId:q.id,outcome:2,statement:'Automatic practice assertion follows the immutable scripted YES fixture. This is not an AI prediction of a real-world event.',sourceURL:q.source.referenceUrl,attachment:JSON.stringify({rulesHash:manifest.rulesHash,fixture:q.source})},owner,manifest.draftHash);
      return {...saved,outcome:2};
    }
    return legacyReleaseEvidence({manifest,event:q,env,archive,owner,assistant:evidenceAssistant({manifest,command,env})});
  };
  // Proposals are off unless explicitly enabled, independently of execution, so rollout testing can
  // execute finishing actions while no outcome is ever proposed.
  const proposals=proposalMode(env);
  if(registry){
    const base=deps.baseManifest!==undefined?deps.baseManifest:await basePilotManifest(env);
    const plan=registryPlan({registry,base,proposals,hold:heldPools(env)});
    // Deterministic pools archive and re-verify public evidence, so they need the public evidence origin.
    if(plan.some(p=>p.manifest.publication.mode===DETERMINISTIC_MODE))settlementPublicOrigin(env.FLURBO_RESOLUTION_EVIDENCE_ORIGIN);
    const pools=plan.map(p=>{
      const m=p.manifest,poolSources=m.publication.mode===DETERMINISTIC_MODE?(deps.sourcesFor?.(m)||sourcesFor(m)):null;
      return {manifest:m,collects:p.collects,sources:poolSources,service:deps.serviceFor?.(m)||pilotService({manifest:m,rpc}),
        evidence:p.proposing?evidenceFor(m,poolSources):null,verifyPendingEvidence:poolSources?.verifyPending,
        ...(p.proposing?{proposerHoldings:deps.proposerHoldingsFor?.(m)||(()=>readProposerHoldings({manifest:m,rpc,owner}))}:{})};
    });
    configured=true;
    const sourceObservations=proposals?await collectSources(pools,now()):[];
    const round=await resolutionRound({pools,owner,command,transport,enabled,now,idle:idlePools(deps.schedule,now())});
    return {...round,proposals,mode:'registry',...(sourceObservations.length?{sourceObservations}:{})};
  }
  const finishing=finishingManifests(env,manifest);
  configured=true;
  // Observe before fixed cutoffs as well as after observation end. The same persistent source
  // history survives worker restarts; observation has no access to the signing transport.
  const sourceObservations=proposals&&sources?await sources.collect(await service.status()):undefined;
  const proposerHoldings=deps.proposerHoldings||(()=>readProposerHoldings({manifest,rpc,owner}));
  if(!finishing)return {...await resolutionTick({manifest,owner,service,command,evidence:proposals?evidenceFor(manifest):null,verifyPendingEvidence:sources?.verifyPending,transport,proposerHoldings,enabled,allowEvidence:proposals,preflight:true,now}),proposals,...(sourceObservations?{sourceObservations}:{})};
  // Only the explicitly allowlisted FLURBO_RESOLUTION_POOL may propose. Every other registered pool is finish-only.
  const pools=[{manifest,service,evidence:proposals?evidenceFor(manifest):null,verifyPendingEvidence:sources?.verifyPending,proposerHoldings},...finishing.map(m=>({manifest:m,service:pilotService({manifest:m,rpc}),evidence:null}))];
  return {...await resolutionRound({pools,owner,command,transport,enabled,now}),proposals,...(sourceObservations?{sourceObservations}:{})};
  }catch(error){
    if(error instanceof ResolutionDiagnostic)throw error;
    throw new ResolutionDiagnostic(configured?'WORKER_CHECK_FAILED':'CONFIGURATION_INVALID');
  }
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  (async()=>{
    if(process.argv.slice(2).some(a=>a!=='--drain')||process.argv.length>3)throw Error('Use --drain or no arguments');
    const deadline=Date.now()+150000,limit=process.argv.includes('--drain')?12:1;
    for(let i=0;i<limit;i++){
      const result=await runResolution();console.log(JSON.stringify(result));
      if(!['submitted','resubmitted','confirmed'].includes(result.status)||Date.now()>deadline)break;
      await new Promise(resolve=>setTimeout(resolve,4000));
    }
  })().catch(error=>{console.error(JSON.stringify(resolutionFailure(error)));process.exitCode=1;});
}
