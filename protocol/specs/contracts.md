# Contracts and deployments

## Supported interface

`flurbo.pilot-pool.v1` on Monad testnet (chain id `10143`). ABI fragments: [abi/pilot-pool.v1.json](../abi/pilot-pool.v1.json) and [abi/erc20.v1.json](../abi/erc20.v1.json). The fragments are generated from `apps/web/shared/pilot.mjs`, the same definitions the web app uses.

| Call | Use |
| --- | --- |
| `quoteBuy(uint32 scope, uint256 mask, uint128 quantity) view returns (uint128)` | Executable buy cost at the block read |
| `quoteSell(uint32 scope, uint256 mask, uint128 quantity) view returns (uint128)` | Executable sell proceeds at the block read |
| `buy(uint32 scope, uint256 mask, uint128 quantity, uint128 maxCost, uint256 deadline) returns (uint128)` | Buy; reverts if the cost exceeds `maxCost`, after `deadline`, or after close |
| `sell(uint32 scope, uint256 mask, uint128 quantity, uint128 minProceeds, uint256 deadline) returns (uint128)` | Sell; reverts below `minProceeds`, after `deadline`, or after close |
| `redeem(uint32 scope, uint256 mask, uint128 quantity) returns (uint128)` | Redeem after resolution at the payout fraction |
| `holdings(address owner, uint32 scope, uint256 mask) view returns (uint128)` | Shares held by a wallet |
| `payoutFraction(uint32 scope, uint256 mask) view returns (uint256, uint256)` | Payout after resolution; reverts before |
| `closesAt()`, `eventCount()`, `collateral()`, `collateralDecimals()`, `resolved()`, `resolvedState()`, `voidMask()`, `settlementRulesHash()`, `funded()` | Deployment and settlement state |
| `event Traded(address indexed trader, uint32 indexed scope, uint256 indexed mask, bool isBuy, uint128 quantity, uint128 collateralAmount)` | Actual cost or proceeds of a trade |
| `event Redeemed(address indexed owner, uint32 indexed scope, uint256 indexed mask, uint128 quantity, uint128 collateralAmount)` | Actual redemption payout |
| ERC-20 `approve`, `allowance`, `balanceOf`, `decimals` | Collateral handling |

The contracts have no caller allowlist: any wallet may trade within the rules above. Nothing in this protocol calls resolver functions; agents never assert, challenge, vote, finalize or deliver.

## Deployment record (`flurbo.agent-deployment.v1`)

The hosted API publishes, per market namespace: chain id, pool, resolver, collateral address and decimals, the keccak-256 code hash of pool and resolver, the settlement rules hash, the close time, the event count, and the service limits below. Before its first trade in a process, and again whenever the deployment record changes, an SDK must:

1. Check `eth_chainId` equals `0x279f` (10143) on its own RPC.
2. Check `keccak256(eth_getCode(pool))` and `keccak256(eth_getCode(resolver))` equal the published hashes.
3. Check `pool.settlementRulesHash()`, `pool.closesAt()`, `pool.eventCount()` and `pool.collateral()` equal the record.
4. Check `collateral.decimals()` equals 6 and the collateral address equals `0xa9012a055bd4e0edff8ce09f960291c09d5322dc`.

Any mismatch stops trading on that deployment with `unsupported_deployment`.

## Service limits (not loosened for agents)

These match the web application's transaction policy (`pilotCall` and `prepare`).

| Limit | Value |
| --- | --- |
| Quantity per `buy`, `sell` or `redeem` | 1 to 100,000,000 atoms (100 shares) |
| `maxCost` or `minProceeds` | at most 100,000,000 atoms |
| Token approval | spender is the pool; amount at most 100,000,000 atoms and equal to the buy limit being prepared |
| Slippage | 10, 50 or 100 bps |
| Deadline | at most 300 seconds after the quote block time, and before `closesAt` |
| Chain id / value | `0x279f`; value `0` |

An execution that falls outside these limits is not accepted as a verified agent execution even if the chain accepted it.
