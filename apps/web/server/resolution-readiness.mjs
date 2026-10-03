import {validateActivityDraft} from '../shared/ethereum-activity.mjs';
import {finishingManifests} from '../scripts/run-resolution.mjs';
import {DETERMINISTIC_MODE,validateSettlementManifest} from './settlement-publication.mjs';
import {settlementPublicOrigin} from './settlement-persistence.mjs';

// Read-only acceptance checks. A ready configuration is not proof of an unattended run.
export function resolutionReadiness({manifest,state,env,inspection,registered=[],monitored=[],gasWei,cashAtoms,gasBudgetWei,holdingsClear=null,pendingNonce,latestNonce,now}){
  const issues=[],warnings=[];
  const add=(code,detail)=>issues.push({code,detail});
  const same=m=>m?.pool===manifest.pool&&m.rulesHash===manifest.rulesHash;
  if(!registered.some(same))add('WEBSITE_NOT_REGISTERED','Pool and rules hash are absent from the supplied website bundle.');
  if(!monitored.some(same))add('MONITOR_NOT_REGISTERED','Pool and rules hash are absent from the monitor bundle.');
  const primary=env.FLURBO_RESOLUTION_POOL===manifest.pool&&env.FLURBO_RESOLUTION_RULES_HASH===manifest.rulesHash;
  if(!primary)add('NOT_PROPOSAL_POOL','This collection is not the explicitly configured proposal pool. Finish-only coverage cannot submit missing results.');
  try{finishingManifests(env,manifest);}catch{add('FINISHING_CONFIGURATION_INVALID','The finishing manifest bundle and exact allowlist must agree before this worker can start.');}
  for(const key of ['FLURBO_MONITOR_ENABLED','FLURBO_RESOLUTION_ENABLED','FLURBO_RESOLUTION_EXECUTE','FLURBO_RESOLUTION_PROPOSALS']){
    if(env[key]!=='true')add('DISABLED_'+key,`${key} is not explicitly true in the supplied environment.`);
  }
  const owner=env.FLURBO_RESOLUTION_SIGNER_ADDRESS?.toLowerCase();
  if(!/^0x[0-9a-f]{40}$/.test(owner||'')||owner===manifest.publication.creator.toLowerCase()||manifest.publication.reviewers.some(r=>r.address.toLowerCase()===owner))add('SIGNER_NOT_DEDICATED','A separate non-creator, non-reviewer signer is required.');
  if(holdingsClear!==true)add('HOLDINGS_UNVERIFIED','Confirm the proposer is position-free before enabling assertions.');
  const m=inspection.monitors?.find(p=>p.pool===manifest.pool);
  if(!m||m.identityMatches!==true||!['observed','attention_required'].includes(m.status)||!Number.isSafeInteger(m.ageSeconds)||m.ageSeconds< -15||m.ageSeconds>900||m.queued!==0)add('MONITOR_UNHEALTHY','Matching fresh monitoring and an empty notification queue are required.');
  if(inspection.anyPending)add('PENDING_TRANSACTION','Reconcile the existing signer journal before launch; do not delete it.');
  if(!Number.isSafeInteger(pendingNonce)||!Number.isSafeInteger(latestNonce)||pendingNonce<0||latestNonce<0)add('NONCE_UNVERIFIED','Read both pending and latest signer nonces before enabling execution.');
  else if(pendingNonce!==latestNonce)add('UNTRACKED_TRANSACTION','Signer pending and latest nonces differ. Reconcile all outstanding transactions first.');
  if(inspection.signerLease?.held)warnings.push('A worker currently holds the signer lease; do not launch a competing signer.');
  const pending=state.cases.filter(c=>c.phase===0).length;
  if(BigInt(cashAtoms)<BigInt(manifest.publication.bondAtoms)*BigInt(pending))add('BOND_FUNDS_LOW','Signer lacks enough test collateral for all currently unasserted event bonds.');
  if(gasBudgetWei===undefined||BigInt(gasBudgetWei)<=0n)add('GAS_BUDGET_UNSPECIFIED','Supply a reviewed gas reserve for this test.');
  else if(BigInt(gasWei)<BigInt(gasBudgetWei))add('GAS_FUNDS_LOW','Signer gas balance is below the requested reserve.');
  if(BigInt(state.poolCash)<BigInt(state.requiredCollateral))add('POOL_UNDERCOLLATERALIZED','Pool collateral coverage failed.');
  if(manifest.publication.mode==='ethereum-activity'){
    try{validateActivityDraft(manifest.publication.draft);}catch{add('UNSUPPORTED_EVIDENCE','Ethereum activity recipe is invalid.');}
  }else if(manifest.publication.mode===DETERMINISTIC_MODE){
    try{validateSettlementManifest(manifest);}catch{add('UNSUPPORTED_EVIDENCE','Deterministic source rules do not match the market commitment.');}
    if(env.FLURBO_RESOLUTION_SOURCE_MODE!==DETERMINISTIC_MODE)add('SOURCE_MODE_DISABLED','Deterministic source proposals require the explicit matching source mode.');
    try{settlementPublicOrigin(env.FLURBO_RESOLUTION_EVIDENCE_ORIGIN);}catch{add('PUBLIC_EVIDENCE_ORIGIN_MISSING','A public HTTPS origin for retained evidence is required.');}
    warnings.push('Verify source captures and public packet readback before execution. Configuration alone does not prove source or evidence availability.');
  }else add('UNATTENDED_SOURCE_UNSUPPORTED','No reviewed deterministic source recipe is configured for this collection.');
  const deadlines=state.cases.map((c,event)=>{
    const assertionDeadline=Number(c.assertionDeadline);
    if(c.phase===0&&now>=assertionDeadline)add('ASSERTION_DEADLINE_MISSED',`Event ${event} can only proceed through the existing timeout rules.`);
    if(c.phase===1){
      const owned=inspection.journal?.pools?.find(p=>p.pool===manifest.pool)?.owned?.[event];
      if(c.asserter?.toLowerCase()!==owner||!owned||owned.evidenceHash!==c.evidenceHash||owned.outcome!==c.proposal)add('ASSERTION_NOT_OWNED',`Event ${event} will not be finalized by this worker without its matching ownership journal. Do not fabricate or reset the journal.`);
      else if(now>=Number(c.challengeUntil))warnings.push(`Event ${event} is due for finalization by its recorded worker.`);
    }
    if(c.phase===2)warnings.push(`Event ${event} is disputed and requires reviewer votes or timeout.`);
    return {event,phase:c.phase,observationEnd:manifest.publication.draft.events[event].observationEndsAt,assertionDeadline};
  });
  return {schema:'flurbo.resolution-readiness.v1',pool:manifest.pool,rulesHash:manifest.rulesHash,checkedAt:now,
    status:state.delivered?'already_delivered':issues.length?'blocked':'configuration_ready',issues,warnings,deadlines,
    schedulerVerified:false,unattendedSettlementVerified:false,
    notice:'Environment and bundle values are supplied locally. Verify they match Render and Actions. Confirm successful scheduled runs and actual proposal/finalization/delivery receipts separately. This report does not sign, submit, activate or certify end-to-end automation.'};
}
