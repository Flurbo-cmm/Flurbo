import { FlurboError } from '../errors.ts';
import { encodeCall, decodeWords } from '../abi.ts';
import { COLLATERAL, COLLATERAL_DECIMALS, type Deployment } from '../protocol.ts';
import { keccak256 } from './signer.ts';
import { toHex, type Rpc } from './rpc.ts';

// Chain reads on the operator's own RPC. Prices are only ever the pool's own quoteBuy and quoteSell at a
// pinned block; nothing here computes a price.
export type Block = { number: bigint; hash: string; timestamp: number };
export type Receipt = { status: 0 | 1; blockNumber: bigint; blockHash: string; gasUsed: bigint; effectiveGasPrice: bigint | null; logs: { address: string; topics: string[]; data: string }[] };

export function chainReader(rpc: Rpc) {
  const call = async (to: string, data: string, tag: string = 'latest') => String(await rpc('eth_call', [{ to, data }, tag]));
  const word = async (to: string, data: string, tag?: string) => decodeWords(await call(to, data, tag), 1)[0];
  async function block(tag: string | bigint = 'latest'): Promise<Block> {
    const b = await rpc('eth_getBlockByNumber', [typeof tag === 'bigint' ? toHex(tag) : tag, false]);
    if (!b?.hash || !b.number) throw new FlurboError('invalid_response', 'The chain returned no block.');
    return { number: BigInt(b.number), hash: String(b.hash).toLowerCase(), timestamp: Number(BigInt(b.timestamp)) };
  }
  return {
    rpc, block,
    async chainId() { return Number(BigInt(await rpc('eth_chainId', []))); },
    // protocol/specs/contracts.md, "Deployment record": every check before trading on a deployment.
    async verifyDeployment(d: Deployment): Promise<void> {
      const fail = (what: string) => { throw new FlurboError('invalid_response', `Unsupported deployment ${d.namespace}: ${what}.`); };
      if (await this.chainId() !== 10143) fail('the RPC is not Monad testnet (10143)');
      const head = toHex((await block()).number);
      for (const [address, expected] of [[d.pool, d.codeHashes.pool], [d.resolver, d.codeHashes.resolver]] as const) {
        const code = String(await rpc('eth_getCode', [address, head]));
        if (code === '0x' || keccak256(code) !== expected) fail('contract code differs from the published deployment');
      }
      const rules = '0x' + (await word(d.pool, encodeCall('settlementRulesHash', []), head)).toString(16).padStart(64, '0');
      if (rules !== d.rulesHash) fail('settlement rules differ');
      if (Number(await word(d.pool, encodeCall('closesAt', []), head)) !== d.closesAt) fail('close time differs');
      if (Number(await word(d.pool, encodeCall('eventCount', []), head)) !== d.eventCount) fail('event count differs');
      const collateral = '0x' + (await word(d.pool, encodeCall('collateral', []), head)).toString(16).padStart(40, '0');
      if (collateral !== COLLATERAL || d.collateral.address !== COLLATERAL) fail('collateral differs');
      if (Number(await word(COLLATERAL, encodeCall('decimals', []), head)) !== COLLATERAL_DECIMALS) fail('collateral decimals differ');
    },
    // A quote at an explicit block. Returns null when the pool does not quote this claim at this size.
    async quote(pool: string, side: 'buy' | 'sell', scope: number, mask: bigint, quantity: bigint, at: Block): Promise<bigint | null> {
      try { return await word(pool, encodeCall(side === 'buy' ? 'quoteBuy' : 'quoteSell', [scope, mask, quantity]), toHex(at.number)); }
      catch (e) { if ((e as { kind?: string }).kind === 'rejected') return null; throw e; }
    },
    resolved: async (pool: string, tag = 'latest') => (await word(pool, encodeCall('resolved', []), tag)) === 1n,
    async resolution(pool: string) {
      if (!await this.resolved(pool)) return null;
      return { yesMask: Number(await word(pool, encodeCall('resolvedState', []))), voidMask: Number(await word(pool, encodeCall('voidMask', []))) };
    },
    holdings: (pool: string, owner: string, scope: number, mask: bigint, tag = 'latest') => word(pool, encodeCall('holdings', [owner, scope, mask]), tag),
    collateralBalance: (owner: string, tag = 'latest') => word(COLLATERAL, encodeCall('balanceOf', [owner]), tag),
    allowance: (owner: string, spender: string, tag = 'latest') => word(COLLATERAL, encodeCall('allowance', [owner, spender]), tag),
    nativeBalance: async (owner: string, tag = 'latest') => BigInt(await rpc('eth_getBalance', [owner, tag])),
    nonce: async (owner: string, tag: 'latest' | 'pending') => Number(BigInt(await rpc('eth_getTransactionCount', [owner, tag]))),
    // Simulation from the wallet. Throws when the call would revert.
    simulate: (from: string, to: string, data: string) => rpc('eth_call', [{ from, to, data, value: '0x0' }, 'latest']),
    estimateGas: async (from: string, to: string, data: string) => BigInt(await rpc('eth_estimateGas', [{ from, to, data, value: '0x0' }])),
    async fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
      const price = BigInt(await rpc('eth_gasPrice', []));
      let priority = 0n;
      try { priority = BigInt(await rpc('eth_maxPriorityFeePerGas', [])); } catch { priority = 0n; }
      const maxFeePerGas = price * 120n / 100n;
      return { maxFeePerGas, maxPriorityFeePerGas: priority < maxFeePerGas ? priority : maxFeePerGas };
    },
    sendRaw: (raw: string) => rpc('eth_sendRawTransaction', [raw]),
    transaction: (hash: string) => rpc('eth_getTransactionByHash', [hash]),
    async receipt(hash: string): Promise<Receipt | null> {
      const r = await rpc('eth_getTransactionReceipt', [hash]);
      if (!r) return null;
      return { status: BigInt(r.status) === 1n ? 1 : 0, blockNumber: BigInt(r.blockNumber), blockHash: String(r.blockHash).toLowerCase(), gasUsed: BigInt(r.gasUsed ?? '0x0'),
        effectiveGasPrice: r.effectiveGasPrice ? BigInt(r.effectiveGasPrice) : null,
        logs: (r.logs ?? []).map((l: any) => ({ address: String(l.address).toLowerCase(), topics: (l.topics ?? []).map((t: string) => String(t).toLowerCase()), data: String(l.data) })) };
    },
  };
}
export type ChainReader = ReturnType<typeof chainReader>;
