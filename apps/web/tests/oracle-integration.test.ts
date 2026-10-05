import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData } from 'viem';
import { wideCommitments } from '../scripts/prepare-wide-pilot.mjs';
import { oracleCatalog, oracleService, proxyAbi, realityAbi, poolAbi, courtAbi, hybridArbitrator,
  HYBRID_ARBITRATORS, KLEROS_PROXY_CODE_HASH, SEPOLIA_KLEROS, SEPOLIA_KLEROS_LIQUID, SEPOLIA_KLEROS_SUBCOURT3,
  SEPOLIA_REALITY } from '../server/oracle-integration.mjs';

const h = (x: string) => `0x${x.repeat(64)}`;
const a = (x: string) => `0x${x.repeat(40)}`;
const publication = { schema: 'flurbo.wide-publication.v3', chainId: 10143,
  trustModel: 'trusted-source-relay', title: 'Oracle fixture', closesAt: 1000,
  relay: a('9'), reportPeriod: 86400, events: [0, 1].map(i => ({ id: `event-${i}`,
    question: `Did event ${i} happen?`, observationEndsAt: 1100,
    source: { kind: 'reality-sepolia', chainId: 11155111, reality: SEPOLIA_REALITY,
      arbitrator: SEPOLIA_KLEROS, questionId: h(i ? '6' : '5'), contentHash: h(i ? '8' : '7'), questionTxHash: h(i ? 'c' : 'b'),
      minTimeout: 3600, minBond: '1000' } })) };
const route = { id: 'test-event', schema: 'flurbo.reality-route.v2', sourceChainId: 11155111,
  marketChainId: 10143, reality: SEPOLIA_REALITY, arbitrator: SEPOLIA_KLEROS,
  pool: a('3'), resolver: a('4'), relay: a('9'), questionId: h('5'), contentHash: h('7'),
  rulesHash: h('a'), eventHash: wideCommitments(publication).eventHashes[0],
  eventIndex: 0, minTimeout: 3600, minBond: '1000',
  evidenceURI: 'https://example.org/evidence.json', publication };
const secondRoute = { ...route, id: 'test-event-two', eventIndex: 1, questionId: h('6'), contentHash: h('8'), eventHash: wideCommitments(publication).eventHashes[1] };
const catalog = { schema: 'flurbo.oracle-catalog.v1', routes: [route, secondRoute] };
const owner = a('b');

function fixture(overrides: Record<string, unknown> = {}) {
  const sourceValues: Record<string, unknown> = {
    realitio: SEPOLIA_REALITY, getContentHash: route.contentHash, getArbitrator: SEPOLIA_KLEROS,
    getTimeout: 3600, getOpeningTS: 1000, getFinalizeTS: 5000, getHistoryHash: h('f'),
    getBond: 1000n, getMinBond: 1000n, getBestAnswer: h('0'),
    isFinalized: false, isPendingArbitration: false, getDisputeFee: 10000000000000000n,
    arbitrationRequests: [0, a('0'), 0n, 0n], balanceOf: 0n,
    arbitrator: a('d'), appealPeriod: [1000n, 4000n], getTotalWithdrawableAmount: 3000n,
  };
  const marketValues: Record<string, unknown> = {
    protocolVersion: 3, collateral: '0xa9012a055bd4e0edff8ce09f960291c09d5322dc', resolver: route.resolver, settlementRulesHash: route.rulesHash,
    eventCount: 2, closesAt: 1000n, funded: true, resolved: false,
    rulesHash: route.rulesHash, pool: route.pool, relay: route.relay,
    eventHashes: route.eventHash, observationEnds: 1100n, reportDeadline: 87500n,
    caseState: { phase: 0, result: 0, evidenceHash: h('0') },
    holdings: 0n, allowance: 0n, balanceOf: 100_000_000n,
    quoteBuy: 500_000n, payoutFraction: [1n, 1n],
  };
  Object.assign(sourceValues, overrides.source || {});
  Object.assign(marketValues, overrides.market || {});
  const source = { getChainId: async () => 11155111, getBlock: async () => ({ timestamp: 2000n, number: 10n }),
    readContract: async ({ functionName }: any) => sourceValues[functionName],
    simulateContract: async () => ({ result: true }),
    getTransactionReceipt: async () => ({ status: 'success', blockNumber: 1n }),
    getBlockNumber: async () => 5n,
    getLogs: async () => overrides.logs || [{ args: { answer: h('0'), history_hash: h('f'), user: owner, bond: 1000n } }] };
  const market = { getChainId: async () => 10143, getBlock: async () => ({ timestamp: BigInt(overrides.marketNow ?? 2000), number: 20n }),
    readContract: async ({ functionName }: any) => marketValues[functionName] };
  return oracleService({ catalog: overrides.catalog || catalog, source, market });
}

test('catalog accepts only the pinned Reality and Kleros contracts', () => {
  assert.equal(oracleCatalog(catalog).routes.length, 2);
  assert.throws(() => oracleCatalog({ ...catalog, routes: [{ ...route, arbitrator: a('2') }, secondRoute] }), /binding mismatch/);
});

test('hybrid arbitrators are the official proxy and the subcourt 3 copy', () => {
  assert.deepEqual(HYBRID_ARBITRATORS.map((x: string) => x.toLowerCase()),
    ['0x05b942faecfb3924970e3a28e0f230910cedff45', '0x9e05da51d17bcd4b796e4505fceed9135bd99964']);
  assert.equal(hybridArbitrator('0x05B942FAECFB3924970E3A28E0F230910CEDFF45'), true);
  assert.equal(hybridArbitrator(SEPOLIA_KLEROS_SUBCOURT3.toLowerCase()), true);
  assert.equal(hybridArbitrator(SEPOLIA_KLEROS_LIQUID), false);
  assert.equal(hybridArbitrator('0x' + '0'.repeat(40)), false);
  assert.equal(hybridArbitrator(undefined), false);
  assert.equal(KLEROS_PROXY_CODE_HASH, '0x41e678fa0e8ad73d464dbaa431d4b61a3f275f5079d75ed8e24b12ac53e4e5ad');
  const fn = (name: string) => (courtAbi as any[]).find(item => item.type === 'function' && item.name === name);
  assert.equal(fn('execute').inputs.length, 3);
  for (const name of ['courts', 'jurors', 'arbitrationCost']) assert.ok(fn(name), name);
});

test('market directory quote reads only the Monad pool', async () => {
  const summary = await fixture({ marketNow: 500 }).marketSummary(route.id);
  assert.equal(summary.id, route.id);
  assert.equal(summary.funded, true);
  assert.equal(summary.prices.yes, '500000');
  assert.equal(summary.prices.no, '500000');
  const closed = await fixture({ marketNow: 1200 }).marketSummary(route.id);
  assert.deepEqual(closed.prices, { yes: null, no: null });
});

test('oracle notice pool exposes answer stage and on-chain position reads', async () => {
  const service = fixture({ catalog: { ...catalog, routes: [
    { ...route, deploymentBlock: 12 }, { ...secondRoute, deploymentBlock: 12 }] },
    market: { holdings: 2_000_000n } });
  const [noticePool] = service.noticePools(async () => null);
  assert.equal(noticePool.label, 'Oracle fixture');
  assert.equal(noticePool.service.eventHref(0), '/markets/oracle/test-event');
  const status = await noticePool.service.status();
  assert.equal(status.cases[0].phase, 1);
  assert.equal(status.cases[0].proposal, 1);
  const positions = await noticePool.service.positions(owner, [{ scope: 1, mask: '1' }]);
  assert.equal(positions.rows[0].quantity, '2000000');
});

test('reads a bound question and prepares exact answer bond', async () => {
  const service = fixture();
  const snap = await service.snapshot(route.id, owner);
  assert.equal(snap.nextBondWei, '2000');
  assert.equal(snap.answerLabel, 'No');
  await assert.rejects(service.prepare(route.id, 'answer', { answer: 'yes', bondEth: '0.000000000000001' }, owner), /minimum/);
  const plan = await service.prepare(route.id, 'answer', { answer: 'yes', bondEth: '0.000000000000002' }, owner);
  assert.equal(plan.transaction.chainId, 11155111);
  assert.equal(plan.transaction.value, '0x7d0');
  const decoded = decodeFunctionData({ abi: realityAbi, data: plan.transaction.data as `0x${string}` });
  assert.equal(decoded.functionName, 'submitAnswer');
  assert.equal(decoded.args?.[2], 1000n);
});

test('prepares arbitration fee for the official proxy and rejects final questions', async () => {
  const plan = await fixture().prepare(route.id, 'arbitrate', {}, owner);
  assert.equal(plan.transaction.to.toLowerCase(), SEPOLIA_KLEROS.toLowerCase());
  assert.equal(BigInt(plan.transaction.value), 10000000000000000n);
  const decoded = decodeFunctionData({ abi: proxyAbi, data: plan.transaction.data as `0x${string}` });
  assert.equal(decoded.functionName, 'requestArbitration');
  await assert.rejects(fixture({ source: { isFinalized: true } }).prepare(route.id, 'arbitrate', {}, owner), /closed/);
});

test('new-pool binding blocks a foreign resolver and a substituted source', async () => {
  await assert.rejects(fixture({ market: { rulesHash: h('f') } }).snapshot(route.id), /binding/);
  await assert.rejects(fixture({ source: { realitio: a('2') } }).snapshot(route.id), /binding/);
});

test('trading prepares a bounded pool transaction after a specific approval', async () => {
  const quote = await fixture({ marketNow: 500 }).prepare(route.id, 'quote', { side: 'yes', quantity: '1' }, owner);
  assert.deepEqual([quote.buyAtoms, quote.maxCostAtoms, quote.allowanceAtoms, quote.holdingsAtoms],
    ['500000', '505000', '0', '0']);
  const approve = await fixture({ marketNow: 500 }).prepare(route.id, 'approve', { side: 'yes', quantity: '1' }, owner);
  assert.equal(approve.transaction.chainId, 10143);
  await assert.rejects(fixture({ marketNow: 500 }).prepare(route.id, 'buy', { side: 'yes', quantity: '1' }, owner), /approve/);
  const buy = await fixture({ marketNow: 500, market: { allowance: 505_000n } }).prepare(route.id, 'buy', { side: 'yes', quantity: '1' }, owner);
  assert.equal(decodeFunctionData({ abi: poolAbi, data: buy.transaction.data as `0x${string}` }).functionName, 'buy');
});


test('a foreign collateral blocks the market and selling checks holdings', async () => {
  await assert.rejects(fixture({ market: { collateral: a('f') } }).snapshot(route.id), /binding/);
  await assert.rejects(fixture({ marketNow: 500 }).prepare(route.id, 'sell', { side: 'yes', quantity: '1' }, owner), /Insufficient shares/);
  const sell = await fixture({ marketNow: 500, market: { holdings: 1_000_000n, quoteSell: 500_000n } })
    .prepare(route.id, 'sell', { side: 'yes', quantity: '1' }, owner);
  assert.equal(decodeFunctionData({ abi: poolAbi, data: sell.transaction.data as `0x${string}` }).functionName, 'sell');
});



test('appeal contributions are simulated on the pinned proxy and rewards can be claimed', async () => {
  const service = fixture({ source: { isPendingArbitration: true,
    arbitrationRequests: [1, owner, 4n, 0n] } });
  const plan = await service.prepare(route.id, 'appeal', { ruling: 2, amountEth: '0.01' }, owner);
  assert.equal(plan.transaction.to.toLowerCase(), SEPOLIA_KLEROS.toLowerCase());
  assert.equal(decodeFunctionData({ abi: proxyAbi, data: plan.transaction.data as `0x${string}` }).functionName, 'fundAppeal');
  const claim = await service.prepare(route.id, 'claimAppeal', { ruling: 2 }, owner);
  assert.equal(claim.rewardWei, '3000');
  assert.equal(decodeFunctionData({ abi: proxyAbi, data: claim.transaction.data as `0x${string}` }).functionName,
    'withdrawFeesAndRewardsForAllRounds');
});


test('a Kleros ruling can be finalized from verified Reality answer history', async () => {
  const service = fixture({ source: { isPendingArbitration: true,
    arbitrationRequests: [2, owner, 4n, 1n] } });
  const plan = await service.prepare(route.id, 'finalizeArbitration', {}, owner);
  const decoded = decodeFunctionData({ abi: proxyAbi, data: plan.transaction.data as `0x${string}` });
  assert.equal(decoded.functionName, 'reportAnswer');
  assert.equal(decoded.args?.[1], h('0'));
  assert.equal(plan.transaction.to.toLowerCase(), SEPOLIA_KLEROS.toLowerCase());
});

test('finalizeArbitration refuses a Reported request', async () => {
  const service = fixture({ source: { isPendingArbitration: true,
    arbitrationRequests: [3, owner, 4n, 2n] } });
  await assert.rejects(service.prepare(route.id, 'finalizeArbitration', {}, owner), /Kleros ruling is not ready to report/);
});

test('Kleros ruling report uses the previous hash after a bond challenge', async () => {
  const logs = [
    { args: { answer: h('0'), history_hash: h('f'), user: owner, bond: 1000n } },
    { args: { answer: h('1'), history_hash: h('e'), user: owner, bond: 2000n } },
  ];
  const service = fixture({ source: { isPendingArbitration: true, getHistoryHash: h('e'),
    getBond: 2000n, arbitrationRequests: [2, owner, 4n, 2n] }, logs });
  const plan = await service.prepare(route.id, 'finalizeArbitration', {}, owner);
  const decoded = decodeFunctionData({ abi: proxyAbi, data: plan.transaction.data as `0x${string}` });
  assert.equal(decoded.args?.[1], h('f'));
  assert.equal(decoded.args?.[2], h('1'));
});

test('final answer bonds can be claimed from the site before withdrawing credited ETH', async () => {
  const service = fixture({ source: { isFinalized: true } });
  const plan = await service.prepare(route.id, 'claimWinnings', {}, owner);
  const decoded = decodeFunctionData({ abi: realityAbi, data: plan.transaction.data as `0x${string}` });
  assert.equal(decoded.functionName, 'claimWinnings');
  assert.deepEqual(decoded.args?.[1], [h('0')]);
  assert.equal((decoded.args?.[2] as string[])[0].toLowerCase(), owner);
  assert.deepEqual(decoded.args?.[3], [1000n]);
  await assert.rejects(fixture().prepare(route.id, 'claimWinnings', {}, owner), /not ready/);
});

test('bond claim accepts the zero-bond final answer written by Kleros', async () => {
  const logs = [
    { args: { answer: h('0'), history_hash: h('f'), user: owner, bond: 1000n } },
    { args: { answer: h('1'), history_hash: h('e'), user: owner, bond: 0n } },
  ];
  const service = fixture({ source: { isFinalized: true, getHistoryHash: h('e') }, logs });
  const plan = await service.prepare(route.id, 'claimWinnings', {}, owner);
  const decoded = decodeFunctionData({ abi: realityAbi, data: plan.transaction.data as `0x${string}` });
  assert.deepEqual(decoded.args?.[1], [h('f'), h('0')]);
  assert.deepEqual(decoded.args?.[3], [0n, 1000n]);
});


test('two-outcome claims encode the AND state and read their own holdings', async () => {
  const claim = [{ eventIndex: 1, side: 'no' }, { eventIndex: 0, side: 'yes' }];
  const service = fixture({ marketNow: 500, market: { allowance: 505_000n, holdings: 1_000_000n } });
  const position = await service.prepare(route.id, 'position', { side: 'yes', claim }, owner);
  assert.equal(position.scope, 3);
  assert.equal(position.mask, 2);
  assert.equal(position.holdingsAtoms, '1000000');
  const buy = await service.prepare(route.id, 'buy', { side: 'yes', quantity: '1', claim }, owner);
  const decoded = decodeFunctionData({ abi: poolAbi, data: buy.transaction.data as `0x${string}` });
  assert.equal(decoded.args?.[0], 3);
  assert.equal(decoded.args?.[1], 2n);
});
