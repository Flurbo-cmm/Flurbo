import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catalog, at, pool, resolver } from './hybrid-catalog-fixture.ts';
import { hybridMarketRpc, hybridPoolIndexes, hybridPortfolioService, MULTICALL3 } from '../server/hybrid-portfolio.mjs';
import { hybridNoticePools } from '../server/hybrid-notices.mjs';

const owner = '0x' + '11'.repeat(20), headHash = '0x' + 'aa'.repeat(32), anchorHash = '0x' + 'bb'.repeat(32);

function fakeMarket(options: { chain?: number; resolver?: string } = {}) {
  const state = { chain: options.chain ?? 10143, resolved: false, resolver: options.resolver ?? resolver,
    headHash, stableHash: headHash, held: new Map<string, bigint>(), reads: [] as any[], blocks: [] as any[],
    multicalls: [] as any[], chainCalls: 0 };
  const rulesHash = catalog().pools[0].rulesHash;
  const market: any = {
    async getChainId() { state.chainCalls++; return state.chain; },
    async getBlock(args?: { blockNumber?: bigint }) {
      state.blocks.push(args);
      if (args?.blockNumber === 100n) return { hash: anchorHash, number: 100n, timestamp: BigInt(at) };
      if (args?.blockNumber === 200n) return { hash: state.stableHash, number: 200n, timestamp: BigInt(at) };
      return { hash: state.headHash, number: 200n, timestamp: BigInt(at) };
    },
    async readContract({ functionName, args, blockNumber }: any) {
      state.reads.push({ functionName, blockNumber });
      if (functionName === 'resolver') return state.resolver;
      if (functionName === 'settlementRulesHash') return rulesHash;
      if (functionName === 'eventCount') return 2n;
      if (functionName === 'resolved') return state.resolved;
      if (functionName === 'factors') return [{ scope: 3, values: [1n] }, { scope: 1, values: [1n] }];
      if (functionName === 'holdings') return state.held.get(`${String(args[0]).toLowerCase()}:${args[1]}:${args[2]}`) ?? 0n;
      if (functionName === 'payoutFraction') return [1n, 2n];
      throw Error(`Unexpected read ${functionName}`);
    },
    async multicall({ contracts, allowFailure, blockNumber, multicallAddress, batchSize }: any) {
      assert.equal(allowFailure, false);
      assert.equal(multicallAddress, MULTICALL3);
      assert.equal(batchSize, 0);
      state.multicalls.push(contracts);
      return Promise.all(contracts.map((call: any) => market.readContract({ ...call, blockNumber })));
    },
  };
  return { market, state };
}
const service = (market: any, extra: object = {}) => hybridPortfolioService({ catalog: catalog(), market, now: () => at, ...extra });
const claims = [{ scope: 1, mask: '2' }, { scope: 1, mask: '1' }, { scope: 3, mask: '8' }];

test('account returns the catalog manifest, a verified head and traded scopes', async () => {
  const { market, state } = fakeMarket();
  const result = await service(market).account(pool.toUpperCase().replace('0X', '0x'));
  const events = catalog().pools[0].prepared.draft.events;
  assert.equal(result.schema, 'flurbo.hybrid-portfolio-account.v1');
  assert.equal(result.manifest.pool, pool.toLowerCase());
  assert.equal(result.manifest.resolver, resolver.toLowerCase());
  assert.equal(result.manifest.chainId, 10143);
  assert.deepEqual(result.manifest.publication.draft.events.map((e: any) => e.id), events.map((e: any) => e.id));
  assert.deepEqual(result.manifest.publication.draft.events.map((e: any) => e.question), events.map((e: any) => e.question));
  assert.deepEqual(result.snapshot, { blockNumber: '200', blockHash: headHash, timestamp: at });
  assert.deepEqual(result.claimScopes, [3, 1]);
  assert.ok(state.reads.length >= 4 && state.reads.every(read => read.blockNumber === 200n));
});

test('account refuses unknown pools, other chains, stale heads and changed bindings', async () => {
  await assert.rejects(service(fakeMarket().market).account('0x' + '9'.repeat(40)), /^Error: Hybrid pool not found$/);
  await assert.rejects(service(fakeMarket({ chain: 1 }).market).account(pool), /Hybrid market RPC chain mismatch/);
  await assert.rejects(service(fakeMarket().market, { now: () => at + 181 }).account(pool), /Stale chain data/);
  await assert.rejects(service(fakeMarket({ resolver: '0x' + '7'.repeat(40) }).market).account(pool), /Hybrid pool differs from verified catalog/);
});

test('positions read one page at one block, keep claim order and price payouts only after resolution', async () => {
  const unresolved = fakeMarket();
  unresolved.state.held.set(`${owner}:1:2`, 4_000_000n);
  unresolved.state.held.set(`${owner}:3:8`, 4_000_000n);
  let result = await service(unresolved.market).positions(pool, owner.toUpperCase().replace('0X', '0x'), claims);
  assert.equal(result.schema, 'flurbo.hybrid-portfolio-positions.v1');
  assert.equal(result.owner, owner);
  assert.equal(result.resolved, false);
  assert.deepEqual(result.rows.map((row: any) => row.payoutAtoms), [null, null, null]);
  assert.deepEqual(result.rows.map((row: any) => row.quantity), ['4000000', '0', '4000000']);
  assert.equal(unresolved.state.multicalls.length, 1);
  const resolved = fakeMarket();
  resolved.state.resolved = true;
  resolved.state.held.set(`${owner}:1:2`, 4_000_000n);
  resolved.state.held.set(`${owner}:3:8`, 4_000_000n);
  result = await service(resolved.market).positions(pool, owner, claims);
  assert.equal(result.resolved, true);
  assert.deepEqual(result.rows.map((row: any) => row.payoutAtoms), ['2000000', '0', '2000000']);
  assert.deepEqual(result.rows.map((row: any) => row.mask), ['2', '1', '8']);
  assert.deepEqual(result.rows.map((row: any) => row.scope), [1, 1, 3]);
  assert.equal(resolved.state.multicalls.length, 2);
  assert.equal(resolved.state.multicalls[1].length, 2);
  assert.ok(resolved.state.multicalls[1].every((call: any) => call.functionName === 'payoutFraction'));
});

test('positions validate the owner and every claim before any chain read', async () => {
  const { market, state } = fakeMarket();
  const api = service(market);
  for (const wallet of ['0x' + '0'.repeat(40), 'abc']) await assert.rejects(api.positions(pool, wallet, claims), /^Error: Invalid wallet address$/);
  await assert.rejects(api.positions(pool, owner, []), /^Error: Use pages of one to sixty claims$/);
  await assert.rejects(api.positions(pool, owner, Array.from({ length: 61 }, () => claims[0])), /^Error: Use pages of one to sixty claims$/);
  for (const bad of [{ scope: 4, mask: '2' }, { scope: 3, mask: '15' }, { scope: 1, mask: '02' }])
    await assert.rejects(api.positions(pool, owner, [claims[0], bad]), /^Error: Unsupported claim$/);
  assert.equal(state.chainCalls + state.reads.length + state.blocks.length + state.multicalls.length, 0);
});

test('positions fail when the snapshot block changes during the read', async () => {
  const { market, state } = fakeMarket();
  state.stableHash = '0x' + 'cc'.repeat(32);
  await assert.rejects(service(market).positions(pool, owner, claims), /Snapshot changed/);
});

test('positions reuse a verified head for a short window', async () => {
  const reused = fakeMarket(), api = service(reused.market);
  await api.positions(pool, owner, claims);
  await api.positions(pool, owner, claims);
  assert.equal(reused.state.chainCalls, 1);
  const fresh = fakeMarket(), noReuse = service(fresh.market, { headReuseMs: 0 });
  await noReuse.positions(pool, owner, claims);
  await noReuse.positions(pool, owner, claims);
  assert.equal(fresh.state.chainCalls, 2);
});

test('history and collected payouts come from the shared pool indexes', async () => {
  const { market } = fakeMarket();
  const history = { complete: true, logs: [] }, payouts = { complete: true, logs: [], through: 1, target: 1 };
  const indexes = new Map([[pool.toLowerCase(), { history: { refresh: async () => history }, payouts: { refresh: async () => payouts } }]]);
  const api = service(market, { indexes });
  assert.equal(await api.history(pool.toUpperCase().replace('0X', '0x')), history);
  assert.equal(await api.payouts(pool.toUpperCase().replace('0X', '0x')), payouts);
  await assert.rejects(api.history('0x' + '9'.repeat(40)), /^Error: Hybrid pool not found$/);
  await assert.rejects(service(market).history(pool), /^Error: Hybrid history unavailable$/);
});

test('a completed history read is reused briefly, an unfinished one is not', async () => {
  const { market } = fakeMarket();
  let reads = 0, complete = true;
  const indexes: any = new Map([[pool.toLowerCase(), { history: { refresh: async () => ({ complete, logs: [], n: ++reads }) },
    payouts: { refresh: async () => ({ complete, logs: [], n: ++reads }) } }]]);
  const api = service(market, { indexes, indexReuseMs: 60_000 });
  await api.history(pool); await api.history(pool); await api.payouts(pool); await api.payouts(pool);
  assert.equal(reads, 2);
  complete = false;
  const partial = service(market, { indexes, indexReuseMs: 60_000 });
  await partial.history(pool); await partial.history(pool);
  assert.equal(reads, 4);
  const none = service(market, { indexes, indexReuseMs: 0 });
  await none.history(pool); await none.history(pool);
  assert.equal(reads, 6);
});

test('pool indexes anchor on the deployment block with lowercase addresses and build each index once', async () => {
  const { market, state } = fakeMarket(), historyCalls: any[] = [], payoutCalls: any[] = [], fallbackRpc = async () => null;
  const command = async () => null;
  const created = (list: any[], name: string) => (options: any) => { list.push(options); return { refresh: async () => ({ name }) }; };
  const indexes = hybridPoolIndexes({ pools: catalog().pools, market, command, fallbackRpc,
    createHistory: created(historyCalls, 'history'), createPayouts: created(payoutCalls, 'payouts') });
  const entry = indexes.get(pool.toLowerCase())!;
  await Promise.all([entry.history.refresh(), entry.history.refresh()]);
  await entry.payouts.refresh();
  assert.equal(state.blocks.filter(args => args?.blockNumber === 100n).length, 1);
  const manifest = { pool: pool.toLowerCase(), resolver: resolver.toLowerCase(), verifiedBlock: 100, verifiedBlockHash: anchorHash };
  assert.equal(historyCalls.length, 1);
  assert.deepEqual(historyCalls[0].manifest, manifest);
  assert.equal(historyCalls[0].maxBlocks, 10_000);
  assert.equal(historyCalls[0].initialWindowSize, 1000);
  assert.equal(historyCalls[0].command, command);
  assert.equal(payoutCalls.length, 1);
  assert.deepEqual(payoutCalls[0].manifest, manifest);
  assert.equal(payoutCalls[0].fallbackRpc, fallbackRpc);
  assert.equal(hybridPoolIndexes({ pools: catalog().pools, market, command: null }).size, 0);
});

test('the market rpc turns provider range limits into a retryable error', async () => {
  const market = { request: async ({ method }: any) => { if (method === 'eth_getLogs') throw Error('query exceeds block range limit'); throw Error('boom'); } };
  const rpc = hybridMarketRpc(market);
  await assert.rejects(rpc('eth_getLogs', []), (error: any) => error.code === 'LOG_RANGE_LIMIT' && /Hybrid log range rejected/.test(error.message));
  await assert.rejects(rpc('eth_blockNumber', []), /boom/);
});

test('hybrid notices reuse the shared history index', async () => {
  const { market, state } = fakeMarket();
  const value = { complete: true, logs: [], marker: 1 };
  const indexes: any = new Map([[pool.toLowerCase(), { history: { refresh: async () => value }, payouts: { refresh: async () => value } }]]);
  const pools = hybridNoticePools({ pools: catalog().pools, market, source: {}, command: async () => null, indexes });
  assert.equal(await pools[0].service.index.refresh(), value);
  assert.equal(state.blocks.length, 0);
});
