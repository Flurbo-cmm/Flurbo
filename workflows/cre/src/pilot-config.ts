import { encodeAbiParameters, keccak256, parseAbiParameters, type Address, type Hex } from 'viem';
import { z } from 'zod';
import { eventDraftSchema, prepareEventDraft } from './event-draft';
import { releaseTargetForEvent } from './github-release';
import { validateRehearsalDraft } from './rehearsal';
import { validateActivityDraft } from '../../../apps/web/shared/ethereum-activity.mjs';
import { DETERMINISTIC_MODE, assertSettlementRuleAuthoring, validateSettlementPublication, pilotRulesHash as committedPilotRulesHash } from '../../../apps/web/server/settlement-publication.mjs';

// Declared locally so viem infers typed ABI parameters; test/pilot-config.test.ts checks it matches the web server's ABI.
export const resolverConfigAbi = parseAbiParameters('(address collateral, bytes32 draftHash, uint64 closesAt, bytes32[] eventHashes, uint64[] observationEnds, address[] reviewers, uint128 bond, uint32 assertionPeriod, uint32 challengePeriod, uint32 votingPeriod) config');

export const PILOT_CASH = '0xa9012a055bd4e0edff8ce09f960291c09d5322dc';
export const VOID_POLICY = 'Valid event outcomes stay fixed. Each void event receives equal YES and NO weight, independently of other void events. Each claim pays its average truth-table payout across compatible states, rounded down to test AUSD atoms on each redemption. This is not a refund of purchase cost. Missing evidence, unresolved ambiguity and reviewer nonresponse produce VOID under the fixed deadlines. No creator override or reviewer replacement is permitted.';
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(v => !/^0x0{40}$/.test(v)).transform(v => v.toLowerCase() as Address);
const duration = (max: number) => z.number().int().min(3600).max(max);
export const pilotInputSchema = z.object({
  schema: z.literal('flurbo.pilot-publication.v1'),
  mode: z.enum(['official-releases','rehearsal','ethereum-activity','deterministic-source-v1']).optional(),
  settlementRules: z.array(z.unknown()).min(2).max(4).optional(),
  creator: address,
  challengePolicy: z.object({version:z.literal('account-holders-v1'),authority:address}).strict().optional(),
  draft: eventDraftSchema,
  reviewers: z.array(z.object({ name: z.string().trim().min(1).max(100), address }).strict()).min(3).max(5),
  reviewerControl: z.enum(['independent-panel', 'single-operator']).default('independent-panel'),
  independentReviewersConfirmed: z.boolean(),
  rulesReviewed: z.literal(true),
  bondAtoms: z.string().regex(/^[1-9][0-9]{0,7}$/),
  assertionPeriod: duration(30 * 86400),
  challengePeriod: duration(7 * 86400),
  votingPeriod: duration(7 * 86400),
}).strict().superRefine((value,ctx)=>{
  if(value.independentReviewersConfirmed !== (value.reviewerControl === 'independent-panel')) {
    ctx.addIssue({code:'custom',path:['independentReviewersConfirmed'],message:'Single-operator mode must disclose false; an independent panel requires true'});
  }
  if ((value.mode === DETERMINISTIC_MODE) !== (value.settlementRules !== undefined)) {
    ctx.addIssue({code:'custom',path:['settlementRules'],message:'Explicit deterministic mode and its rules must be supplied together'});
  }
});

export function disputePolicy(input: { challengePolicy?:{version:'account-holders-v1';authority:string}; reviewerControl?: 'independent-panel'|'single-operator'; creator?: string; reviewers: {name: string; address: string}[]; bondAtoms: string; assertionPeriod: number; challengePeriod: number; votingPeriod: number }) {
  if(input.reviewerControl==='single-operator' && !input.creator) throw new Error('Operator identity is required');
  const control=input.reviewerControl==='single-operator'
    ? `Operator-run testnet alpha. All reviewer wallets are controlled by the creator (${input.creator!.toLowerCase()}). These wallets are not independent reviewers. The operator can determine disputed outcomes through the voting quorum. ` : '';
  const eligibility=input.challengePolicy?`Holder-only challenges: the signing wallet and a qualifying holder must belong to the same verified Flurbo account. A dedicated server signer (${input.challengePolicy.authority.toLowerCase()}) attests membership; the resolver checks live shares in the disputed event. Authorizations expire within 120 seconds and are single use. Any positive quantity counts, including dependent combinations and canonical wrapped shares. No qualifying shares means no challenge. Signer compromise can falsify membership; signer unavailability prevents challenges. Existing reviewer and asserter exclusions still apply. `:'';
  return eligibility+control+`Named testnet reviewer panel: ${input.reviewers.map(r => `${r.name} (${r.address.toLowerCase()})`).join(', ')}. Quorum ${Math.floor(input.reviewers.length / 2) + 1} of ${input.reviewers.length} matching votes. One test AUSD has 1000000 atoms. Assertion and dispute bond: ${input.bondAtoms} atoms each. Assertion window: ${input.assertionPeriod} seconds after observation end. Challenge window: ${input.challengePeriod} seconds after assertion. Vote window: ${input.votingPeriod} seconds after dispute. Reviewers cannot assert or dispute from their registered addresses. One vote per reviewer per event. Unchallenged assertions return their bond. A panel decision matching a party pays both bonds to that party. Third outcomes and voting timeouts return each party's own bond. Missing assertions and voting timeouts finalize VOID. Anyone may finalize elapsed deadlines and deliver all final results. Test bonds provide no economic security; panel members are explicitly trusted.`;
}

// Pool depth b in collateral atoms. 250 test AUSD keeps a 10-share trade within about 1% of the
// quoted price; funding is b * ln(2^events) (about 347 test AUSD for two questions). Deployed pools
// keep the b they were created with; this only applies to new preparations.
export const DEFAULT_LIQUIDITY_ATOMS = '250000000';
export function validLiquidityAtoms(value: string) {
  return /^[1-9][0-9]*$/.test(value) && BigInt(value) >= 10_000_000n && BigInt(value) <= 1_000_000_000_000n;
}

// `reproduce` rebuilds a publication that was already prepared (verification of a deployed pool): the committed
// hashes are checked, but authoring policy added after it was prepared is not applied again.
export function preparePilot(input: unknown, now: number, liquidityAtoms: string = DEFAULT_LIQUIDITY_ATOMS, { reproduce = false } = {}) {
  if (!validLiquidityAtoms(liquidityAtoms)) throw new Error('Liquidity must be between 10 and 1,000,000 test AUSD in atoms');
  const value = pilotInputSchema.parse(input);
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('Invalid preparation time');
  if (![3, 5].includes(value.reviewers.length) || new Set(value.reviewers.map(r => r.address)).size !== value.reviewers.length
    || new Set(value.reviewers.map(r => r.name.toLowerCase())).size !== value.reviewers.length) throw new Error('Use three or five distinct named reviewers');
  if (value.draft.closesAt <= now + 3600 || value.draft.closesAt > now + 30 * 86400) throw new Error('Close must be between one hour and thirty days from preparation');
  if (value.draft.events.some(e => e.observationEndsAt > now + 90 * 86400)) throw new Error('Observation window exceeds pilot limit');
  if (value.draft.disputeModel !== 'reviewer-panel' || value.draft.exceptionPolicy !== VOID_POLICY || value.draft.disputePolicy !== disputePolicy(value)) throw new Error('Draft must contain the exact reviewed pilot policies');
  if(value.challengePolicy && [value.creator,...value.reviewers.map(r=>r.address)].includes(value.challengePolicy.authority))throw Error('Use a dedicated eligibility signer');
  const records = new Set<string>();
  if(value.mode==='rehearsal')validateRehearsalDraft(value.draft);
  if(value.mode==='ethereum-activity')validateActivityDraft(value.draft);
  if(value.mode===DETERMINISTIC_MODE){validateSettlementPublication(value);if(!reproduce)value.settlementRules!.forEach(assertSettlementRuleAuthoring);}
  for (const event of value.draft.events) {
    if(value.mode!=='rehearsal'&&value.mode!=='ethereum-activity'&&value.mode!==DETERMINISTIC_MODE)releaseTargetForEvent(value.draft, event.id);
    if (records.has(event.source.recordId)) throw new Error('Do not duplicate the same release as separate events');
    records.add(event.source.recordId);
  }
  const { draftHash } = prepareEventDraft(value.draft, now);
  const eventHashes = value.draft.events.map((event, bit) => keccak256(encodeAbiParameters(
    parseAbiParameters('string domain, bytes32 draftHash, uint8 bit, string eventId'),
    ['flurbo.pilot.event.v1', draftHash, bit, event.id],
  )));
  const config = {
    collateral: PILOT_CASH as Address, draftHash, closesAt: BigInt(value.draft.closesAt), eventHashes,
    observationEnds: value.draft.events.map(e => BigInt(e.observationEndsAt)), reviewers: value.reviewers.map(r => r.address),
    bond: BigInt(value.bondAtoms), assertionPeriod: value.assertionPeriod, challengePeriod: value.challengePeriod, votingPeriod: value.votingPeriod,
  };
  const resolverConfig = encodeAbiParameters(resolverConfigAbi, [config]);
  return { schema: 'flurbo.pilot-prepared.v1', status: 'prepared_not_deployed', preparedAt: now,
    creator: value.creator, publication: value, draftHash, eventHashes, resolverConfig,
    configHash: keccak256(resolverConfig), liquidityAtoms,
    notice: 'Preparation does not publish a market, verify reviewer independence or establish evidence delivery. Deployment and public acceptance remain separate.' };
}

export function pilotRulesHash(config: Parameters<typeof encodeAbiParameters<typeof resolverConfigAbi>>[1][0], resolver: Address, creator: Address, policy?:{version:'account-holders-v1';authority:string}): Hex {
  return committedPilotRulesHash(config, resolver, creator, policy);
}
