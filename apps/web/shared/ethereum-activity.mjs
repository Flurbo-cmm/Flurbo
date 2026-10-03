// Canonical source rules shared by preparation and the isolated resolution worker.
export const ACTIVITY_MODE='ethereum-activity';
export const ACTIVITY_TITLE='Showcase v0';
export const ACTIVITY_METRICS=['fullness','transactions','fees','blobs'];
export const TEST_ACTIVITY_METRICS=['fullness','transactions'];
// A separate, fixed recipe for the two-event automation acceptance collection.
// Keep legacy Showcase identity and rule validation byte-for-byte compatible.
export function activityMetrics(draft){
  if(draft?.title===ACTIVITY_TITLE&&draft.clusterId===`showcase-v0-${draft.closesAt}`)return ACTIVITY_METRICS;
  if(draft?.title==='Test'&&draft.clusterId===`ethereum-test-v1-${draft.closesAt}`)return TEST_ACTIVITY_METRICS;
  throw Error('Unsupported Ethereum activity collection');
}
export function activityEvent(metric,target){
  const bit=ACTIVITY_METRICS.indexOf(metric);
  if(bit<0||!Number.isSafeInteger(target)||target<=0)throw Error('Invalid Ethereum activity target');
  const conditions=['gasUsed * 4 >= gasLimit * 3','transaction count >= 150','baseFeePerGas > parent.baseFeePerGas','blobGasUsed >= 393216'];
  return {id:`ethereum-${metric}`,question:['Will Ethereum fill at least 75% of a block?','Will Ethereum include at least 150 transactions?','Will Ethereum’s base fee rise?','Will Ethereum carry at least 3 blobs?'][bit],
    yesRule:`YES if ${conditions[bit]} in the selected finalized Ethereum mainnet block.`,
    noRule:`NO if the selected finalized block is available and the YES condition is false. Missing, conflicting or unfinalized data is not NO.`,
    observationStartsAt:target,observationEndsAt:target+1800,
    source:{publisher:'Ethereum mainnet',referenceUrl:'https://ethereum.org/developers/docs/apis/json-rpc/',recordId:`ethereum-activity.v1:${metric}:${target}`,
      selectionRule:`Select the first Ethereum mainnet execution block with timestamp >= ${target}; its immediate parent must have timestamp < ${target}. Read gasUsed, gasLimit, transaction count, baseFeePerGas and blobGasUsed from that block; compare fees with its parent.`,
      finalityRule:'PublicNode (https://ethereum-rpc.publicnode.com) and dRPC (https://eth.drpc.org) must both report the selected block as finalized and agree on its hash, parent and measured fields. RPC reports are evidence, not a cryptographic finality proof. The bonded assertion and challenge process decides the final outcome.',
      revisionRule:'Archive the first corroborated observation. Conflicting later data requires a challenge, never silent evidence replacement. Missing or unfinalized evidence leaves the assertion unset; fixed contract deadlines and VOID rules apply.'}};
}
export function validateActivityDraft(draft){
  const metrics=activityMetrics(draft);
  if(draft.events?.length!==metrics.length)throw Error('Invalid activity event count');
  const target=draft.closesAt+120;
  for(let i=0;i<metrics.length;i++){
    const actual=draft.events[i],expected=activityEvent(metrics[i],target);
    for(const key of ['id','question','yesRule','noRule','observationStartsAt','observationEndsAt'])if(actual?.[key]!==expected[key])throw Error('Ethereum activity rule changed');
    if(Object.keys(actual.source||{}).length!==Object.keys(expected.source).length||Object.entries(expected.source).some(([k,v])=>actual.source[k]!==v))throw Error('Ethereum activity source changed');
  }
  return target;
}
export function activityOutcome(metric,block,parent){
  switch(metric){
    case 'fullness':return block.gasUsed*4n>=block.gasLimit*3n?2:1;
    case 'transactions':return block.transactions>=150?2:1;
    case 'fees':return block.baseFeePerGas>parent.baseFeePerGas?2:1;
    case 'blobs':return block.blobGasUsed>=393216n?2:1;
    default:throw Error('Unsupported metric');
  }
}
