import { parseAbi, parseAbiParameters } from 'viem';
import deployment from '../../../config/learning-testnet.json' with { type: 'json' };

export const learningDeployment = deployment;
export const factor = '(uint32 scope, uint128[] values)[]';
export const market = `(uint8 events, uint128 liquidity, uint8 decimals, ${factor} factors, uint8[] order)`;
export const update = `(uint256 chainId, address pool, uint256 expectedRevision, uint256 deadline, uint128 maxFunding, ${factor} bias)`;
export const updateParameters = parseAbiParameters(update);
export const poolAbi = parseAbi([
  ...['revision', 'lastUpdateAt', 'updateCount', 'fundingEpoch'].map(name => `function ${name}() view returns (uint256)`),
  ...['epochFundingSpent', 'pricingReserve', 'actualRequiredCollateral'].map(name => `function ${name}() view returns (uint128)`),
  'function funded() view returns (bool)', 'function resolved() view returns (bool)',
  `function factors() view returns (${factor})`, `function biasFactors() view returns (${factor})`,
  'function quoteBuy(uint32 scope, uint256 mask, uint128 quantity) view returns (uint128)',
  `function updateBias(${update} proposal) returns (uint128)`,
  'event BiasUpdated(uint256 indexed revision, bytes32 indexed proposalHash, uint128 fundingAdded, uint128 reserve)',
]);
export const cashAbi = parseAbi(['function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)']);
export const engineAbi = parseAbi([`function reserve(${market} market, ${factor} bias) pure returns (uint128)`,
  `function quote(${market} market, ${factor} bias, uint32 scope, uint256 mask, uint128 quantity, bool isBuy) pure returns ((uint128 collateral, ${factor} factorsAfter, uint128 maxLiabilityAfter) result, uint128 reserveAfter)`]);
