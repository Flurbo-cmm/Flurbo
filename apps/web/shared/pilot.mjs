import { parseAbi, decodeFunctionData, encodeFunctionData } from 'viem';
import {holderResolverAbi,dependsOnEvent} from './holder-challenge.mjs';

export const pilotCash = '0xa9012a055bd4e0edff8ce09f960291c09d5322dc';
export const resolverAbi = parseAbi([
  ...['creator','collateral','pool'].map(n => `function ${n}() view returns (address)`),
  ...['draftHash','rulesHash'].map(n => `function ${n}() view returns (bytes32)`),
  'function closesAt() view returns (uint64)', 'function bond() view returns (uint128)',
  ...['assertionPeriod','challengePeriod','votingPeriod'].map(n => `function ${n}() view returns (uint32)`),
  'function quorum() view returns (uint8)', 'function eventCount() view returns (uint8)',
  'function reviewers(uint256) view returns (address)', 'function eventHashes(uint256) view returns (bytes32)',
  'function observationEnds(uint256) view returns (uint64)', 'function assertionDeadline(uint8) view returns (uint64)',
  'function isReviewer(address) view returns (bool)', 'function voted(uint8,address) view returns (bool)',
  'function credits(address) view returns (uint256)', 'function lockedBonds() view returns (uint256)',
  'function totalCredits() view returns (uint256)', 'function delivered() view returns (bool)',
  'function caseState(uint8) view returns ((uint8 phase,uint8 proposal,uint8 counter,uint8 result,address asserter,address disputer,bytes32 evidenceHash,bytes32 counterEvidenceHash,uint64 challengeUntil,uint64 voteUntil,uint8[3] votes))',
  'function assertOutcome(uint8,uint8,bytes32,string)', 'function dispute(uint8,uint8,bytes32,string)',
  'function vote(uint8,uint8,bytes32,string)', 'function finalize(uint8)', 'function deliver()', 'function withdrawBond()',
  'event Asserted(uint8 indexed eventIndex,address indexed asserter,uint8 outcome,bytes32 evidenceHash,string evidenceURI,uint64 challengeUntil)',
  'event Disputed(uint8 indexed eventIndex,address indexed disputer,uint8 outcome,bytes32 evidenceHash,string evidenceURI,uint64 voteUntil)',
  'event Voted(uint8 indexed eventIndex,address indexed reviewer,uint8 outcome,bytes32 rationaleHash,string rationaleURI)',
  'event Finalized(uint8 indexed eventIndex,uint8 outcome,bool timedOut)',
  'event Delivered(address indexed pool,uint32 yesMask,uint32 voidMask)',
]);
export const pilotPoolAbi = parseAbi([
  ...['resolver','collateral','baseTokenFactory'].map(n => `function ${n}() view returns (address)`),
  'function settlementRulesHash() view returns (bytes32)', 'function closesAt() view returns (uint64)',
  'function eventCount() view returns (uint8)', 'function collateralDecimals() view returns (uint8)',
  'function eliminationOrder() view returns (uint8[])',
  'function factors() view returns ((uint32 scope,uint128[] values)[])',
  ...['liquidity','requiredFunding','requiredCollateral'].map(n => `function ${n}() view returns (uint128)`),
  'function funded() view returns (bool)', 'function resolved() view returns (bool)',
  'function resolvedState() view returns (uint32)', 'function voidMask() view returns (uint32)',
  'function baseTokens(uint32,uint8) view returns (address)',
  'function holdings(address,uint32,uint256) view returns (uint128)',
  'function payoutFraction(uint32,uint256) view returns (uint256,uint256)',
  'function quoteBuy(uint32,uint256,uint128) view returns (uint128)',
  'function quoteSell(uint32,uint256,uint128) view returns (uint128)',
  'function buy(uint32,uint256,uint128,uint128,uint256) returns (uint128)',
  'function sell(uint32,uint256,uint128,uint128,uint256) returns (uint128)',
  'function redeem(uint32,uint256,uint128) returns (uint128)',
  'function wrapBase(uint8,bool,uint128)', 'function unwrapBase(uint8,bool,uint128)',
  'event Traded(address indexed trader,uint32 indexed scope,uint256 indexed mask,bool isBuy,uint128 quantity,uint128 collateralAmount)',
  'event Redeemed(address indexed owner,uint32 indexed scope,uint256 indexed mask,uint128 quantity,uint128 collateralAmount)',
  'event Resolved(uint32 indexed yesMask,uint32 indexed voidMask,bytes32 indexed rulesHash)',
]);
export const pilotCashAbi = parseAbi(['function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)']);

export function evidenceURI(value) {
  if (typeof value !== 'string' || value.length > 512 || /[\s\u0000-\u001f\u007f]/.test(value)) return false;
  try { const url = new URL(value); return ['https:', 'ipfs:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password; }
  catch { return false; }
}

// Mirrors FactoredCost.validate: pricing eliminates questions in the pool's fixed order, and eliminating one may
// join at most three questions (induced width 2). Every distinct combination ever traded stays in the pool, so
// once some questions are linked, a new combination can be refused although each question is still open.
export const COMBINATION_LIMIT_MESSAGE='This pool cannot accept this combination. Combinations already bought here link these questions as far as the pool can price, so this one would link one question to more than two others. Each question and other combinations can still be traded; see Docs, Combined predictions.';
export function combinationFits(events, order, scopes, scope) {
  if (!Array.isArray(order) || order.length !== events || !Array.isArray(scopes)) return false;
  if (scopes.includes(scope)) return true;
  const popcount = value => value.toString(2).replace(/0/g, '').length;
  const pending = [...scopes, scope];
  for (const index of order) {
    const bit = 1 << index;
    let joined = bit;
    for (let j = 0; j < pending.length; j++) {
      if (pending[j] & bit) { joined |= pending[j]; pending[j] = 0; }
    }
    if (popcount(joined) - 1 > 2) return false;
    pending.push(joined & ~bit);
  }
  return true;
}

export function validClaim(scope, mask, count) {
  const width = Number(scope).toString(2).replace(/0/g, '').length;
  return Number.isInteger(scope) && scope > 0 && scope < 2 ** count && width <= 3
    && typeof mask === 'bigint' && mask > 0n && mask < (1n << BigInt(2 ** width)) - 1n;
}

// The same decoder guards browser review, Mera signing and server raw submission.
// Re-encoding rejects extra/trailing bytes and noncanonical dynamic arguments.
export function pilotCall({to, data, manifest}) {
  try {
    const target = to.toLowerCase();
    const disputeAbi=manifest.challengePolicy?[...resolverAbi.filter(item=>!(item.type==='function'&&item.name==='dispute')),...holderResolverAbi]:resolverAbi;
    const abi = target === manifest.resolver ? disputeAbi : target === manifest.pool ? pilotPoolAbi : target === pilotCash ? pilotCashAbi : null;
    if (!abi) return null;
    const decoded = decodeFunctionData({abi, data});
    if (encodeFunctionData({abi, ...decoded}).toLowerCase() !== data.toLowerCase()) return null;
    const {functionName: name, args=[]} = decoded;
    const count=manifest.publication.draft.events.length;
    if (abi === disputeAbi) {
      if (['assertOutcome','dispute','vote'].includes(name)) {
        if (args[0] >= count || args[1] < 1 || args[1] > 3 || /^0x0{64}$/.test(args[2]) || !evidenceURI(args[3])) return null;
        if(name==='dispute'&&manifest.challengePolicy){const e=args[4];if(!e||!dependsOnEvent(e.scope,e.mask,args[0],count)||!/^0x[0-9a-f]{130}$/i.test(args[5])||e.deadline<=0n||/^0x0{40}$/i.test(e.holder)||/^0x0{40}$/i.test(e.challenger))return null;}
      } else if (name === 'finalize') { if (args[0] >= count) return null; }
      else if (!['deliver','withdrawBond'].includes(name)) return null;
    } else if (abi === pilotCashAbi) {
      if (name !== 'approve' || ![manifest.pool,manifest.resolver].includes(args[0].toLowerCase())
        || args[1] > (args[0].toLowerCase() === manifest.resolver ? BigInt(manifest.publication.bondAtoms) : 100_000_000n)) return null;
    } else if (['buy','sell','redeem'].includes(name)) {
      if (!validClaim(args[0],args[1],count) || args[2] <= 0n || args[2] > 100_000_000n) return null;
      if (name !== 'redeem' && args[3] > 100_000_000n) return null;
    } else if (['wrapBase','unwrapBase'].includes(name)) {
      if (args[0] >= count || args[2] <= 0n || args[2] > 100_000_000n) return null;
    } else return null;
    return {abi, name, args};
  } catch { return null; }
}
