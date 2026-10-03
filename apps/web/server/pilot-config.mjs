import { readFile } from 'node:fs/promises';
import { pilotService, pilotRpc } from './pilot.mjs';
import { pilotIndex } from './pilot-index.mjs';
import { payoutIndexWithFallback } from './payout-index.mjs';
import { pairAnalytics } from './pair-analytics.mjs';
import { claimAnalytics } from './claim-analytics.mjs';
import { thesisAnalytics } from './thesis-analytics.mjs';
import {validateActivityDraft} from '../shared/ethereum-activity.mjs';
import {DETERMINISTIC_MODE,validateSettlementManifest} from './settlement-publication.mjs';

const payouts=({manifest,rpcUrl,command})=>payoutIndexWithFallback({manifest,command,rpc:pilotRpc(rpcUrl),
  fallbackRpc:new URL(rpcUrl).hostname==='testnet-rpc.monad.xyz'?null:pilotRpc('https://testnet-rpc.monad.xyz')});

// Public deployment data only. Explicit overrides are validated and never silently
// replaced by another market. Disabling access does not stop on-chain deadlines.
export async function configurePilot({env=process.env,rpcUrl,command,read=readFile}) {
  if(env.FLURBO_PILOT_DISABLED !== undefined && !['true','false'].includes(env.FLURBO_PILOT_DISABLED)) throw new Error('Invalid pilot disable setting');
  if(env.FLURBO_PILOT_DISABLED === 'true') return null;
  const raw=env.FLURBO_PILOT_MANIFEST_JSON !== undefined
    ? env.FLURBO_PILOT_MANIFEST_JSON
    : await read(new URL('../../../config/pilot-testnet.json',import.meta.url),'utf8');
  const service=pilotService({manifest:JSON.parse(raw),rpc:pilotRpc(rpcUrl),snapshotReuseMs:2500});
  if(['rehearsal','ethereum-activity',DETERMINISTIC_MODE].includes(service.manifest.publication.mode))throw new Error('New collections cannot replace the original pilot');
  service.index=pilotIndex({manifest:service.manifest,rpc:pilotRpc(rpcUrl),command});
  service.payouts=payouts({manifest:service.manifest,rpcUrl,command});
  service.analytics=pairAnalytics({service,rpc:pilotRpc(rpcUrl)});
  service.claimAnalytics=claimAnalytics({service,rpc:pilotRpc(rpcUrl)});
  service.thesisAnalytics=thesisAnalytics({service,rpc:pilotRpc(rpcUrl)});
  return service;
}

export async function configureRehearsal({env=process.env,rpcUrl,command}) {
  if(env.FLURBO_REHEARSAL_MANIFEST_JSON===undefined)return null;
  const manifest=JSON.parse(env.FLURBO_REHEARSAL_MANIFEST_JSON);
  if(manifest.publication?.mode!=='rehearsal'||manifest.publication.draft?.title!=='Public rehearsal: scripted settlement checks')throw new Error('Verified scripted rehearsal required');
  const service=pilotService({manifest,rpc:pilotRpc(rpcUrl),snapshotReuseMs:2500});
  service.index=pilotIndex({manifest,rpc:pilotRpc(rpcUrl),command});
  service.payouts=payouts({manifest:service.manifest,rpcUrl,command});
  service.analytics=pairAnalytics({service,rpc:pilotRpc(rpcUrl)});
  service.claimAnalytics=claimAnalytics({service,rpc:pilotRpc(rpcUrl)});
  service.thesisAnalytics=thesisAnalytics({service,rpc:pilotRpc(rpcUrl)});
  return service;
}

export async function configureCollection({manifest,rpcUrl,command}){
  if(manifest?.publication?.mode==='rehearsal')return configureRehearsal({env:{FLURBO_REHEARSAL_MANIFEST_JSON:JSON.stringify(manifest)},rpcUrl,command});
  if(manifest?.publication?.mode===DETERMINISTIC_MODE)validateSettlementManifest(manifest);
  else if(manifest?.publication?.mode==='ethereum-activity')validateActivityDraft(manifest.publication.draft);
  else throw Error('Unsupported collection mode');
  const service=pilotService({manifest,rpc:pilotRpc(rpcUrl),snapshotReuseMs:2500});
  service.index=pilotIndex({manifest,rpc:pilotRpc(rpcUrl),command});
  service.payouts=payouts({manifest:service.manifest,rpcUrl,command});
  service.analytics=pairAnalytics({service,rpc:pilotRpc(rpcUrl)});
  service.claimAnalytics=claimAnalytics({service,rpc:pilotRpc(rpcUrl)});
  service.thesisAnalytics=thesisAnalytics({service,rpc:pilotRpc(rpcUrl)});
  return service;
}
