import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { decodeFunctionData, getAddress } from 'viem';
import { conditionalMarketService } from '../server/conditional-market-service.mjs';
import { TEST_AUSD } from '../server/oracle-integration.mjs';
import { certifiedConditional } from '../server/pair-math.mjs';
import { condPoolAbi, conditionalCall, runtimeCodeHash, shapeKey } from '../shared/conditionals.mjs';
import { pilotCashAbi } from '../shared/pilot.mjs';
import { ATOM_TO_WAD, depthRateWad, depthWad, lsAnalyticsState } from '../shared/ls-lmsr.mjs';
import { account, at, hybridRecord } from './hybrid-catalog-fixture.ts';

const fixtures = JSON.parse(await readFile(new URL('./fixtures/conditionals.json', import.meta.url), 'utf8'));
const stateRow = fixtures.find((r: any) => r.name === 'state_b_given_a');
const pricer = account('c'), owner = account('8'), pricerCode = '0x60016002' + 'a165627a7a72' + '0007';
const record = { ...hybridRecord({ commissionBps: 500 }), id: 'cond-test', conditionalVersion: 1 };
const catalog = { schema: 'flurbo.conditional-catalog.v1', pricer, pools: [record] };
const prepared: any = record.prepared;
const factors = [{ scope: 1, values: [0n, 8_000_000n] }, { scope: 3, values: [0n, 0n, 0n, 6_000_000n] }];
const depth = depthWad(10_000_000n * ATOM_TO_WAD, depthRateWad(2, 500),
  factors.map(f => ({ scope: f.scope, values: f.values.map(v => v * ATOM_TO_WAD) })));
const aGivesB = { condition: [{ eventIndex: 0, side: 'yes' }], target: [{ eventIndex: 1, side: 'yes' }] };
const shape = { conditionScope: 1, conditionMask: 2n, targetScope: 2, targetMask: 2n };

function interpolate(price: bigint) {
  const samples = stateRow.samples.map(([p, c]: string[]) => [BigInt(p), BigInt(c)]);
  const upper = samples.findIndex(([p]: bigint[]) => p >= price);
  if (samples[upper][0] === price) return samples[upper][1];
  const [p0, c0] = samples[upper - 1], [p1, c1] = samples[upper];
  return (c0 * (p1 - p0) + (c1 - c0) * (price - p0) + (p1 - p0) - 1n) / (p1 - p0);
}

function harness({ open = true, resolved = false, code = pricerCode, version = 1, linked = pricer, cash = 100_000_000n,
  allowance = 0n, held = [] as { shape: any; shares: bigint; refund: bigint }[] } = {}) {
  const reads: { functionName: string; blockNumber?: bigint }[] = [];
  const market = {
    getChainId: async () => 10143,
    getBytecode: async ({ address }: any) => { assert.equal(address, getAddress(pricer)); return code; },
    getBlock: async (input?: any) => ({ hash: `0x${'9'.repeat(64)}`, number: input?.blockNumber ?? 200n,
      timestamp: BigInt(open ? prepared.draft.closesAt - 600 : prepared.draft.closesAt + 600) }),
    readContract: async ({ address, functionName, args = [], blockNumber }: any) => {
      reads.push({ functionName, blockNumber });
      const isPool = address.toLowerCase() === record.pool.toLowerCase();
      const keys = held.map(h => shapeKey(h.shape));
      const holding = (key: string) => held.find(h => shapeKey(h.shape) === key);
      const values: Record<string, () => unknown> = {
        protocolVersion: () => isPool ? 5 : 4, rulesHash: () => record.rulesHash, draftHash: () => prepared.draftHash,
        pool: () => record.pool, proposer: () => prepared.proposer, relay: () => prepared.relay, bond: () => 1000000n,
        eventCount: () => 2, eventHashes: () => prepared.eventHashes[Number(args[0])],
        observationEnds: () => BigInt(prepared.draft.events[Number(args[0])].observationEndsAt), routes: () => 0,
        resolver: () => record.resolver, settlementRulesHash: () => record.rulesHash, collateral: () => TEST_AUSD,
        funded: () => true, resolved: () => resolved, delivered: () => resolved, liquidity: () => 10_000_000n,
        commissionBps: () => 500, sponsor: () => prepared.creator, conditionalVersion: () => version, pricer: () => linked,
        depth: () => depth, eliminationOrder: () => [0, 1], factors: () => factors,
        resolvedState: () => 3, voidMask: () => 0,
        quoteConditionalBuy: () => { assert.equal(shapeKey(args[0]), shapeKey(shape)); assert.equal(args[1], 1_000_000n); return interpolate(args[2]); },
        quoteConditionalSell: () => [BigInt(args[2]) / 2n, holding(shapeKey(args[0]))!.refund * BigInt(args[2]) / holding(shapeKey(args[0]))!.shares],
        conditionalPayout: () => holding(shapeKey(args[0]))?.shares ?? 0n,
        shapeCount: () => BigInt(held.length + 1),
        shapeAt: () => Number(args[0]) < held.length ? [keys[Number(args[0])], held[Number(args[0])].shape]
          : [shapeKey({ conditionScope: 2, conditionMask: 1n, targetScope: 1, targetMask: 1n }), { conditionScope: 2, conditionMask: 1n, targetScope: 1, targetMask: 1n }],
        conditionalHolding: () => { const h = holding(args[1]); return h ? [h.shares, h.refund] : [0n, 0n]; },
        balanceOf: () => cash, allowance: () => allowance,
        quoteBuy: () => BigInt(args[2]) / 2n, quoteSell: () => BigInt(args[2]) / 3n, holdings: () => 0n,
      };
      if (!(functionName in values)) throw Error(`Unexpected ${functionName}`);
      return values[functionName]();
    },
  };
  const service = conditionalMarketService({ catalog, market, source: {}, evidence: {}, origin: 'https://example.org',
    pricerCodeHash: runtimeCodeHash(pricerCode) });
  return { service, reads };
}

test('list returns only conditional pools', async () => {
  const { service } = harness();
  assert.equal(service.status(), 'unchecked');
  const list = await service.list();
  assert.equal(list.schema, 'flurbo.conditional-directory.v1');
  assert.deepEqual(list.pools, [{ id: 'cond-test', pool: record.pool, title: prepared.draft.title,
    questions: prepared.draft.events.map((e: any) => e.question), closesAt: prepared.draft.closesAt }]);
  assert.equal(service.status(), 'available');
});

test('the service is unavailable when the pricer code hash differs', async () => {
  for (const options of [{ code: '0x6001' }, { version: 2 }, { linked: account('d') }]) {
    const { service } = harness(options);
    await assert.rejects(service.list(), /Conditional markets are unavailable/);
    assert.equal(service.status(), 'unavailable');
    await assert.rejects(service.pool(record.pool), /Conditional markets are unavailable/);
    await assert.rejects(service.quote(record.pool, { ...aGivesB, shares: '1000000' }, owner), /Conditional markets are unavailable/);
  }
});

test('pool lists every question with its pairs and chance', async () => {
  const { service } = harness();
  const view = await service.pool(record.pool);
  assert.equal(view.schema, 'flurbo.conditional-pool.v1');
  assert.equal(view.open, true);
  assert.deepEqual(view.questions.map((q: any) => q.question), prepared.draft.events.map((e: any) => e.question));
  assert.deepEqual(view.questions.map((q: any) => q.pairable), [[1], [0]]);
  assert.equal(typeof view.questions[0].chance, 'number');
  await assert.rejects(service.pool(account('e')), /Conditional pool not found/);
});

test('chances returns certified values at a confirmed block', async () => {
  const { service } = harness();
  const result = await service.chances(record.pool, aGivesB);
  const { state } = lsAnalyticsState({ events: 2, a: 0, b: 1, initialDepthAtoms: '10000000', commissionBps: 500,
    order: [0, 1], factors: factors.map(f => ({ scope: f.scope, values: f.values.map(String) })) });
  assert.deepEqual(result.values, certifiedConditional(state, [{ event: 0, yes: true }], [{ event: 1, yes: true }]).values);
  assert.equal(result.values.given, Math.round(Number(stateRow.before.given) * 1000));
  assert.equal(result.blockNumber, '200');
  assert.equal(result.blockHash, `0x${'9'.repeat(64)}`);
  assert.equal(result.unit, 'tenths_of_percentage_point');
  for (const bad of [{}, { condition: [], target: aGivesB.target }, { condition: aGivesB.condition, target: aGivesB.condition },
    { ...aGivesB, extra: 1 }, { condition: [{ eventIndex: 2, side: 'yes' }], target: aGivesB.target }])
    await assert.rejects(service.chances(record.pool, bad), /Invalid conditional|Choose/);
});

test('quote solves the price and adds the margin', async () => {
  const { service, reads } = harness();
  const quote = await service.quote(record.pool, { ...aGivesB, shares: '1000000' }, owner);
  const price = BigInt(quote.priceAtoms), pay = BigInt(quote.payAtoms);
  assert.ok(interpolate(price) <= price && price >= BigInt(stateRow.fairAtoms));
  assert.equal(pay, price + (price + 199n) / 200n);
  assert.equal(quote.refundAtoms, quote.payAtoms);
  assert.deepEqual(quote.payoffs, { both: '1000000', conditionOnly: '0', refund: quote.payAtoms });
  assert.equal(quote.shape.conditionMask, '2');
  assert.equal(quote.key, shapeKey(shape));
  assert.ok(quote.reads <= 5);
  assert.ok(reads.filter(r => r.functionName === 'quoteConditionalBuy').every(r => r.blockNumber === 200n));
  assert.equal(quote.cashAtoms, '100000000');
});

test('quote refuses more than 20 shares', async () => {
  const { service } = harness();
  for (const shares of ['20000001', '0', '999999', '1.5', 1000000])
    await assert.rejects(service.quote(record.pool, { ...aGivesB, shares }, owner), /Enter one to twenty shares/);
});

test('quote refuses a closed pool', async () => {
  const { service } = harness({ open: false });
  await assert.rejects(service.quote(record.pool, { ...aGivesB, shares: '1000000' }, owner), /Trading is closed/);
});

test('prepare builds approve, buy, sell and redeem that pass conditionalCall', async () => {
  const pool = record.pool;
  const check = (plan: any) => {
    const call = conditionalCall({ to: plan.transaction.to, data: plan.transaction.data, pool, events: 2 });
    assert.ok(call, plan.action);
    assert.equal(plan.transaction.chainId, 10143);
    assert.equal(plan.transaction.from, getAddress(owner));
    return call!;
  };
  const approval = await harness().service.prepare(pool, 'approve', { ...aGivesB, shares: '1000000' }, owner);
  const approved = check(approval);
  assert.equal(approved.name, 'approve');
  assert.equal(approval.transaction.to.toLowerCase(), TEST_AUSD);
  assert.equal(decodeFunctionData({ abi: pilotCashAbi, data: approval.transaction.data }).args[1], BigInt(approval.amountAtoms));
  const buy = await harness({ allowance: 100_000_000n }).service.prepare(pool, 'buy', { ...aGivesB, shares: '1000000' }, owner);
  const bought = check(buy);
  assert.equal(bought.name, 'buyConditional');
  assert.equal(bought.args[2], BigInt(buy.payAtoms));
  assert.equal(bought.args[3], BigInt(buy.expiresAt));
  assert.equal(buy.expiresAt, prepared.draft.closesAt - 600 + 120);
  const held = [{ shape, shares: 3_000_000n, refund: 2_100_000n }];
  const wire = { conditionScope: 1, conditionMask: '2', targetScope: 2, targetMask: '2' };
  const sale = await harness({ held }).service.prepare(pool, 'sell', { shape: wire, shares: '2000000' }, owner);
  const sold = check(sale);
  assert.equal(sold.name, 'sellConditional');
  assert.equal(sale.amountAtoms, '1000000');
  assert.equal(sold.args[2], 1_000_000n - 1_000_000n / 200n);
  await assert.rejects(harness({ held }).service.prepare(pool, 'sell', { shape: wire, shares: '3000001' }, owner), /No conditional holding/);
  const redeem = await harness({ held, open: false, resolved: true }).service.prepare(pool, 'redeem', { shape: wire }, owner);
  assert.equal(check(redeem).name, 'redeemConditional');
  assert.equal(redeem.amountAtoms, '3000000');
  await assert.rejects(harness({ held }).service.prepare(pool, 'redeem', { shape: wire }, owner), /not ready to collect/);
  await assert.rejects(harness().service.prepare(pool, 'buy', { ...aGivesB, shares: '1000000' }, 'nope'), /Select a MetaMask wallet/);
  await assert.rejects(harness().service.prepare(pool, 'transfer', { ...aGivesB, shares: '1000000' }, owner), /Conditional action unavailable/);
});

test('buy requires cash and allowance for the pay amount', async () => {
  const pool = record.pool;
  await assert.rejects(harness({ allowance: 0n }).service.prepare(pool, 'buy', { ...aGivesB, shares: '1000000' }, owner),
    /Fund and approve this purchase first/);
  await assert.rejects(harness({ allowance: 100_000_000n, cash: 1n }).service.prepare(pool, 'buy', { ...aGivesB, shares: '1000000' }, owner),
    /Fund and approve this purchase first/);
  await assert.rejects(harness({ allowance: 100_000_000n }).service.prepare(pool, 'approve', { ...aGivesB, shares: '1000000' }, owner),
    /Approval already covers this trade/);
});

test('holdings lists nonzero holdings with sell quotes before resolution and payouts after', async () => {
  const held = [{ shape, shares: 3_000_000n, refund: 2_100_000n }];
  const open = await harness({ held }).service.holdings(record.pool, owner);
  assert.equal(open.schema, 'flurbo.conditional-holdings.v1');
  assert.equal(open.holdings.length, 1);
  assert.deepEqual(open.holdings[0], { key: shapeKey(shape), shape: { conditionScope: 1, conditionMask: '2', targetScope: 2, targetMask: '2' },
    condition: { rule: 'AND', legs: [{ event: 0, yes: true }] }, target: { rule: 'AND', legs: [{ event: 1, yes: true }] },
    sharesAtoms: '3000000', refundAtoms: '2100000', sellAtoms: '1500000', payoutAtoms: null });
  const settled = await harness({ held, open: false, resolved: true }).service.holdings(record.pool, owner);
  assert.equal(settled.holdings[0].payoutAtoms, '3000000');
  assert.equal(settled.holdings[0].sellAtoms, null);
  await assert.rejects(harness().service.holdings(record.pool, 'nope'), /Invalid wallet address/);
});

test('single-answer actions delegate to the hybrid service over the conditional catalog', async () => {
  const { service } = harness();
  const quote = await service.questions.prepare(`${record.pool}-0`, 'quote', { side: 'yes', quantity: '2000000' }, owner);
  assert.equal(quote.buyAtoms, '1000000');
  assert.equal(service.questions.list().length, 2);
  assert.equal(service.questions.list()[0].pool, record.pool);
  assert.throws(() => service.ruleFor(`0x${'1'.repeat(64)}`), /Hybrid rule not found/);
});
