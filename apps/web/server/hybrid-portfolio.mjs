import { getAddress, parseAbi } from 'viem';
import { pilotIndex } from './pilot-index.mjs';
import { payoutIndexWithFallback } from './payout-index.mjs';
import { hybridSettlementCatalog } from './hybrid-settlement-worker.mjs';
import { validClaim } from '../shared/pilot.mjs';

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
export const HYBRID_PORTFOLIO_INPUT_ERRORS = new Set(['Hybrid pool not found', 'Invalid wallet address',
  'Use pages of one to sixty claims', 'Unsupported claim']);

const poolAbi = parseAbi(['function resolver() view returns (address)',
  'function settlementRulesHash() view returns (bytes32)', 'function eventCount() view returns (uint8)',
  'function resolved() view returns (bool)', 'function factors() view returns ((uint32 scope,uint128[] values)[])',
  'function holdings(address,uint32,uint256) view returns (uint128)',
  'function payoutFraction(uint32,uint256) view returns (uint256,uint256)']);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const hash32 = value => /^0x[0-9a-fA-F]{64}$/.test(value || '');
const RANGE_LIMIT = /block range|range.{0,40}(limit|large|exceed)|limit.{0,40}range|too many (results|logs)|response size/i;

export function hybridMarketRpc(market) {
  return async (method, params) => {
    try { return await market.request({ method, params }); }
    catch (error) {
      if (method === 'eth_getLogs' && RANGE_LIMIT.test(String(error?.message || '')))
        throw Object.assign(Error('Hybrid log range rejected'), { code: 'LOG_RANGE_LIMIT' });
      throw error;
    }
  };
}

// One history index and one payout index per pool, shared by member notices and Portfolio so a pool is
// scanned once per process and each persisted index has a single writer.
export function hybridPoolIndexes({ pools, market, command, fallbackRpc = null,
  createHistory = pilotIndex, createPayouts = payoutIndexWithFallback }) {
  const indexes = new Map();
  if (!command) return indexes;
  const rpc = hybridMarketRpc(market);
  for (const record of pools) {
    let anchor = null, history = null, payouts = null;
    const manifest = () => anchor ??= market.getBlock({ blockNumber: BigInt(record.deploymentBlock) })
      .then(block => {
        if (!hash32(block?.hash)) throw Error('Hybrid deployment block unavailable');
        return { pool: record.pool.toLowerCase(), resolver: record.resolver.toLowerCase(),
          verifiedBlock: record.deploymentBlock, verifiedBlockHash: block.hash.toLowerCase() };
      }).catch(error => { anchor = null; throw error; });
    indexes.set(record.pool.toLowerCase(), {
      history: { async refresh() {
        const value = await manifest();
        history ??= createHistory({ manifest: value, command, rpc, maxBlocks: 10_000, initialWindowSize: 1000 });
        return history.refresh();
      } },
      payouts: { async refresh() {
        const value = await manifest();
        payouts ??= createPayouts({ manifest: value, command, rpc, fallbackRpc });
        return payouts.refresh();
      } },
    });
  }
  return indexes;
}

export function hybridPortfolioService({ catalog, market, indexes = new Map(),
  now = () => Math.floor(Date.now() / 1000), headReuseMs = 2500, indexReuseMs = 5000 }) {
  const records = new Map(hybridSettlementCatalog(catalog).pools.map(record => [record.pool.toLowerCase(), record]));
  const heads = new Map(), reads = new Map();
  const recordFor = pool => {
    const record = records.get(String(pool).toLowerCase());
    if (!record) throw Error('Hybrid pool not found');
    return record;
  };
  const walletOf = value => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(value || '') || /^0x0{40}$/.test(value)) throw Error('Invalid wallet address');
    return value.toLowerCase();
  };
  const read = (record, functionName, args, blockNumber) => market.readContract({
    address: getAddress(record.pool), abi: poolAbi, functionName, args, blockNumber });
  async function verifiedHead(record) {
    if (Number(await market.getChainId()) !== 10143) throw Error('Hybrid market RPC chain mismatch');
    const block = await market.getBlock();
    if (!hash32(block?.hash) || typeof block.number !== 'bigint') throw Error('Hybrid market block unavailable');
    const age = now() - Number(block.timestamp);
    if (age < -15 || age > 180) throw Error('Stale chain data');
    const [resolver, rulesHash, count] = await Promise.all([
      read(record, 'resolver', [], block.number), read(record, 'settlementRulesHash', [], block.number),
      read(record, 'eventCount', [], block.number)]);
    if (!same(resolver, record.resolver) || !same(rulesHash, record.rulesHash)
      || Number(count) !== record.prepared.draft.events.length) throw Error('Hybrid pool differs from verified catalog');
    return { blockNumber: block.number.toString(), blockHash: block.hash.toLowerCase(), timestamp: Number(block.timestamp) };
  }
  function head(record, reuse = false) {
    const key = record.pool.toLowerCase(), entry = heads.get(key);
    if (reuse && entry && Date.now() - entry.at < headReuseMs) return entry.value;
    const next = { at: Date.now(), value: verifiedHead(record) };
    heads.set(key, next);
    next.value.catch(() => { if (heads.get(key) === next) heads.delete(key); });
    return next.value;
  }
  async function stable(snapshot) {
    const block = await market.getBlock({ blockNumber: BigInt(snapshot.blockNumber) });
    if (!same(block?.hash, snapshot.blockHash)) throw Error('Snapshot changed');
  }
  const manifestFor = record => ({ pool: record.pool.toLowerCase(), resolver: record.resolver.toLowerCase(), chainId: 10143,
    publication: { draft: { title: record.prepared.draft.title, closesAt: record.prepared.draft.closesAt,
      events: record.prepared.draft.events.map(event => ({ id: event.id, question: event.question,
        route: event.route, observationEndsAt: event.observationEndsAt })) } } });
  // A finished catch-up is served again for a few seconds. Many tabs and wallets share one scan, and an
  // unfinished scan always continues on the next request.
  async function indexFor(pool, kind) {
    const record = recordFor(pool), key = `${record.pool.toLowerCase()}:${kind}`, index = indexes.get(record.pool.toLowerCase());
    if (!index) throw Error('Hybrid history unavailable');
    const saved = reads.get(key);
    if (saved && Date.now() - saved.at < indexReuseMs) return saved.value;
    const value = await index[kind].refresh();
    if (value?.complete) reads.set(key, { at: Date.now(), value }); else reads.delete(key);
    return value;
  }
  return {
    async account(pool) {
      const record = recordFor(pool), snapshot = await head(record);
      const factors = await read(record, 'factors', [], BigInt(snapshot.blockNumber));
      await stable(snapshot);
      return { schema: 'flurbo.hybrid-portfolio-account.v1', manifest: manifestFor(record), snapshot,
        claimScopes: [...new Set(factors.map(factor => Number(factor.scope)))] };
    },
    async positions(pool, owner, claims) {
      const record = recordFor(pool), wallet = walletOf(owner), events = record.prepared.draft.events.length;
      if (!Array.isArray(claims) || claims.length < 1 || claims.length > 60) throw Error('Use pages of one to sixty claims');
      for (const claim of claims)
        if (!Number.isInteger(claim?.scope) || typeof claim.mask !== 'string' || !/^[1-9]\d{0,2}$/.test(claim.mask)
          || !validClaim(claim.scope, BigInt(claim.mask), events)) throw Error('Unsupported claim');
      const snapshot = await head(record, true), blockNumber = BigInt(snapshot.blockNumber), address = getAddress(record.pool);
      const [resolved, quantities] = await Promise.all([read(record, 'resolved', [], blockNumber),
        market.multicall({ contracts: claims.map(claim => ({ address, abi: poolAbi, functionName: 'holdings',
          args: [getAddress(wallet), claim.scope, BigInt(claim.mask)] })),
        allowFailure: false, blockNumber, multicallAddress: MULTICALL3, batchSize: 0 })]);
      const payouts = new Map();
      if (resolved) {
        const held = claims.map((claim, index) => ({ claim, index })).filter(({ index }) => BigInt(quantities[index]) > 0n);
        if (held.length) {
          const fractions = await market.multicall({ contracts: held.map(({ claim }) => ({ address, abi: poolAbi,
            functionName: 'payoutFraction', args: [claim.scope, BigInt(claim.mask)] })),
          allowFailure: false, blockNumber, multicallAddress: MULTICALL3, batchSize: 0 });
          held.forEach(({ index }, i) => {
            const [numerator, denominator] = fractions[i];
            if (BigInt(denominator) === 0n) throw Error('Hybrid payout unavailable');
            payouts.set(index, BigInt(quantities[index]) * BigInt(numerator) / BigInt(denominator));
          });
        }
      }
      await stable(snapshot);
      return { schema: 'flurbo.hybrid-portfolio-positions.v1', owner: wallet, snapshot, resolved: !!resolved,
        rows: claims.map((claim, index) => ({ scope: claim.scope, mask: claim.mask, quantity: BigInt(quantities[index]).toString(),
          payoutAtoms: resolved ? (payouts.get(index) ?? 0n).toString() : null })) };
    },
    async history(pool) { return indexFor(pool, 'history'); },
    async payouts(pool) { return indexFor(pool, 'payouts'); },
  };
}
