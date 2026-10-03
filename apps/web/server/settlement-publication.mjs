import { encodeAbiParameters, keccak256, parseAbiParameters } from 'viem';
import { canonical, settlementRuleHash, validateSettlementRule } from './settlement-rules.mjs';
export { assertSettlementRuleAuthoring, SNAPSHOT_SETTLE_SECONDS } from './settlement-rules.mjs';

export const DETERMINISTIC_MODE = 'deterministic-source-v1';
export const PILOT_CASH = '0xa9012a055bd4e0edff8ce09f960291c09d5322dc';
export const eventDraftAbi = parseAbiParameters(
  'string domain, uint256 chainId, string clusterId, string title, uint64 closesAt, '
  + '(string id, string question, string yesRule, string noRule, uint64 observationStartsAt, uint64 observationEndsAt, '
  + '(string publisher, string referenceUrl, string recordId, string selectionRule, string finalityRule, string revisionRule) source)[] events, '
  + 'bool hasExceptionPolicy, string exceptionPolicy, string disputeModel, bool hasDisputePolicy, string disputePolicy',
);
export const resolverConfigAbi = parseAbiParameters('(address collateral, bytes32 draftHash, uint64 closesAt, bytes32[] eventHashes, uint64[] observationEnds, address[] reviewers, uint128 bond, uint32 assertionPeriod, uint32 challengePeriod, uint32 votingPeriod) config');
const integer = value => Number.isSafeInteger(value) && value > 0;
const address = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/.test(value) && !/^0x0{40}$/.test(value);

// The existing draft ABI commits every field below. In particular, recordId
// commits the entire machine-readable rule, including parser, source and cutoffs.
// Human-readable questions remain authored rules, not an LLM interpretation.
export function settlementEvent(input) {
  const rule = validateSettlementRule(input), t = rule.timing;
  const reference = new URL(rule.source.urls[0]);
  reference.search = '';
  const condition = `${rule.decision.type} ${rule.decision.operator} ${JSON.stringify(rule.decision.value)}`;
  return {
    id: rule.eventId, question: rule.question,
    yesRule: `YES if the valid source record selected by the committed rule satisfies ${condition}. Missing or ambiguous evidence does not mean NO.`,
    noRule: `NO if the valid source record selected by the committed rule does not satisfy ${condition}. Missing or ambiguous evidence follows the committed VOID timeout.`,
    observationStartsAt: t.scheduledAt, observationEndsAt: t.observationEndsAt,
    source: {
      publisher: rule.source.publisher, referenceUrl: reference.href,
      recordId: `settlement-rule:sha256:${settlementRuleHash(rule)}`,
      selectionRule: `Adapter ${rule.source.adapter}; source ${rule.source.id}; series ${rule.observation.series}; period ${rule.observation.period}; unit ${rule.observation.unit}. Only the exact URLs and record-selection rules in the committed settlement rule are accepted.`,
      finalityRule: `UTC seconds: observation start ${t.scheduledAt}; publication cutoff ${t.publicationCutoff}; correction cutoff and observation end ${t.observationEndsAt}. Assertion window ${t.assertionPeriod}; challenge window ${t.challengePeriod}; voting window ${t.votingPeriod}. All transitions require transactions.`,
      revisionRule: `Vintage ${rule.vintage}. Missing policy ${rule.missingPolicy}. Source revisions and unavailable evidence follow the committed rule; the operator cannot change it after deployment.`,
    },
  };
}

export function encodeEventDraft(draft) {
  return encodeAbiParameters(eventDraftAbi, [
    draft.schema, BigInt(draft.chainId), draft.clusterId, draft.title, BigInt(draft.closesAt),
    draft.events.map(event => ({ ...event, observationStartsAt: BigInt(event.observationStartsAt), observationEndsAt: BigInt(event.observationEndsAt) })),
    draft.exceptionPolicy !== null, draft.exceptionPolicy ?? '', draft.disputeModel,
    draft.disputePolicy !== null, draft.disputePolicy ?? '',
  ]);
}

export function validateSettlementPublication(publication) {
  if (publication?.schema !== 'flurbo.pilot-publication.v1' || publication.mode !== DETERMINISTIC_MODE
    || !address(publication.creator) || !publication.rulesReviewed
    || !Array.isArray(publication.reviewers) || ![3, 5].includes(publication.reviewers.length)
    || publication.reviewers.some(reviewer => !address(reviewer.address))
    || new Set(publication.reviewers.map(reviewer => reviewer.address)).size !== publication.reviewers.length) throw Error('Invalid deterministic publication');
  const draft = publication.draft, rules = publication.settlementRules;
  if (draft?.schema !== 'flurbo.event-draft.v1' || draft.status !== 'draft' || draft.chainId !== 10143
    || !integer(draft.closesAt) || !Array.isArray(draft.events) || ![2, 3, 4].includes(draft.events.length)
    || !Array.isArray(rules) || rules.length !== draft.events.length) throw Error('Exact event-indexed settlement rules required');
  const seen = new Set();
  for (let bit = 0; bit < rules.length; bit++) {
    const rule = validateSettlementRule(rules[bit]), event = settlementEvent(rule);
    if (seen.has(rule.eventId) || !/^[a-z0-9][a-z0-9:_-]{0,95}$/.test(rule.eventId)) throw Error('Distinct settlement event IDs required');
    seen.add(rule.eventId);
    if (canonical(event) !== canonical(draft.events[bit])) throw Error('Settlement rule does not match its committed draft event');
    if (draft.closesAt >= rule.timing.scheduledAt || rule.timing.observationEndsAt <= rule.timing.scheduledAt
      || ['assertionPeriod', 'challengePeriod', 'votingPeriod'].some(key => rule.timing[key] !== publication[key])) throw Error('Settlement rule and resolver timing mismatch');
  }
  return rules;
}

export function settlementBindings(publication) {
  validateSettlementPublication(publication);
  const draft = publication.draft, draftHash = keccak256(encodeEventDraft(draft));
  const eventHashes = draft.events.map((event, bit) => keccak256(encodeAbiParameters(
    parseAbiParameters('string domain, bytes32 draftHash, uint8 bit, string eventId'),
    ['flurbo.pilot.event.v1', draftHash, bit, event.id],
  )));
  const config = {
    collateral: PILOT_CASH, draftHash, closesAt: BigInt(draft.closesAt), eventHashes,
    observationEnds: draft.events.map(event => BigInt(event.observationEndsAt)), reviewers: publication.reviewers.map(reviewer => reviewer.address),
    bond: BigInt(publication.bondAtoms), assertionPeriod: publication.assertionPeriod,
    challengePeriod: publication.challengePeriod, votingPeriod: publication.votingPeriod,
  };
  const resolverConfig = encodeAbiParameters(resolverConfigAbi, [config]);
  return { draftHash, eventHashes, config, resolverConfig, configHash: keccak256(resolverConfig) };
}

export function pilotRulesHash(config, resolver, creator, policy) {
  if (policy) return keccak256(encodeAbiParameters([
    ...parseAbiParameters('string domain, uint256 chainId, address resolver, address creator'), ...resolverConfigAbi, ...parseAbiParameters('address authority'),
  ], ['flurbo.pilot.account-holders.v1', 10143n, resolver, creator, config, policy.authority]));
  return keccak256(encodeAbiParameters([
    ...parseAbiParameters('string domain, uint256 chainId, address resolver, address creator'), ...resolverConfigAbi,
  ], ['flurbo.pilot.uniform-void.v1', 10143n, resolver, creator, config]));
}

// This checks the public commitment chain, not deployment provenance. The normal
// pilot snapshot still verifies these hashes against the live pool and resolver.
export function validateSettlementManifest(manifest) {
  if (manifest?.schema !== 'flurbo.pilot-manifest.v1' || manifest.status !== 'verified_pilot_snapshot'
    || manifest.chainId !== 10143 || !address(manifest.pool) || !address(manifest.resolver)) throw Error('Verified deterministic manifest required');
  const publication = manifest.publication, rules = validateSettlementPublication(publication);
  if (canonical(manifest.challengePolicy ?? null) !== canonical(publication.challengePolicy ?? null)) throw Error('Challenge policy binding mismatch');
  const bindings = settlementBindings(publication);
  if (manifest.draftHash !== bindings.draftHash || manifest.configHash !== bindings.configHash
    || manifest.rulesHash !== pilotRulesHash(bindings.config, manifest.resolver, publication.creator, publication.challengePolicy)) throw Error('Settlement manifest commitment mismatch');
  return rules;
}
