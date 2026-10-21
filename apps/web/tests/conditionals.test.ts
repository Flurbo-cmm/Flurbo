import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { encodeAbiParameters, encodeFunctionData, keccak256 } from 'viem';
import { CONDITIONAL_VERSION, LS_PRICER_CODE_HASH, MAX_SHAPES, PRICER_VERSION, condPoolAbi, conditionalCall,
  runtimeCodeHash, shapeFromAnswers, shapeKey, shapePayout, shapeVector, solveConditionalPrice, validateShape } from '../shared/conditionals.mjs';
import { pilotCash, pilotCashAbi } from '../shared/pilot.mjs';

const fixtures = JSON.parse(await readFile(new URL('./fixtures/conditionals.json', import.meta.url), 'utf8'));
const row = (name: string) => fixtures.find((r: any) => r.name === name);
const shape = (conditionScope: number, conditionMask: number, targetScope: number, targetMask: number) =>
  ({ conditionScope, conditionMask: BigInt(conditionMask), targetScope, targetMask: BigInt(targetMask) });
const pool = '0x' + '42'.repeat(20);

test('constants match the contracts', () => {
  assert.equal(CONDITIONAL_VERSION, 1);
  assert.equal(PRICER_VERSION, 1);
  assert.equal(MAX_SHAPES, 256);
  assert.match(LS_PRICER_CODE_HASH, /^0x[0-9a-f]{64}$/);
});

const pricerArtifacts = (await Promise.all(['../../../target/foundry/out/LsPricer.sol/LsPricer.json',
  '../../../../Flurbo-contracts/target/foundry/out/LsPricer.sol/LsPricer.json']
  .map(path => readFile(new URL(path, import.meta.url), 'utf8').then(JSON.parse).catch(() => null)))).filter(Boolean);

test('LS_PRICER_CODE_HASH matches the compiled pricer', { skip: pricerArtifacts.length ? false : 'no compiled LsPricer artifact' }, () => {
  for (const artifact of pricerArtifacts) assert.equal(runtimeCodeHash(artifact.deployedBytecode.object), LS_PRICER_CODE_HASH);
  assert.equal(runtimeCodeHash('0x6001' + 'a1' + '0001'), keccak256('0x6001'));
  assert.equal(runtimeCodeHash('0x00'), keccak256('0x00'));
  assert.equal(runtimeCodeHash('0x'), null);
});

test('validateShape mirrors the contract rules', () => {
  assert.equal(validateShape(shape(1, 2, 2, 2), 3).scope, 3);
  assert.equal(validateShape(shape(1, 2, 6, 8), 3).scope, 7);
  assert.equal(validateShape(shape(3, 8, 4, 2), 3).scope, 7);
  assert.equal(validateShape(shape(4, 1, 1, 2), 3).scope, 5);
  assert.equal(validateShape({ conditionScope: 1, conditionMask: '2', targetScope: 2, targetMask: '2' }, 2).scope, 3);
  const bad: [ReturnType<typeof shape>, number][] = [
    [shape(1, 2, 1, 2), 4], [shape(3, 8, 2, 2), 4], [shape(0, 1, 2, 2), 4], [shape(1, 2, 0, 1), 4],
    [shape(7, 128, 8, 2), 4], [shape(3, 8, 12, 8), 4], [shape(1, 2, 8, 2), 3], [shape(1, 0, 2, 2), 4],
    [shape(1, 2, 2, 0), 4], [shape(1, 3, 2, 2), 4], [shape(3, 15, 4, 2), 4], [shape(1, 4, 2, 2), 4],
  ];
  for (const [s, events] of bad) assert.throws(() => validateShape(s, events), /^Error: Invalid conditional$/, JSON.stringify(s, (_, v) => typeof v === 'bigint' ? String(v) : v));
  for (const value of [null, {}, { ...shape(1, 2, 2, 2), conditionScope: 1.5 }, { ...shape(1, 2, 2, 2), targetMask: '-1' }, { ...shape(1, 2, 2, 2), extra: 1 }])
    assert.throws(() => validateShape(value as any, 3), /Invalid conditional/);
});

test('shapeFromAnswers encodes condition and target answers with claim masks', () => {
  assert.deepEqual(shapeFromAnswers({ events: 2, condition: [{ event: 0, yes: true }], target: [{ event: 1, yes: true }] }), shape(1, 2, 2, 2));
  assert.deepEqual(shapeFromAnswers({ events: 2, condition: [{ event: 0, yes: false }], target: [{ event: 1, yes: true }] }), shape(1, 1, 2, 2));
  assert.deepEqual(shapeFromAnswers({ events: 3, condition: [{ event: 0, yes: true }], target: [{ event: 2, yes: true }, { event: 1, yes: true }] }), shape(1, 2, 6, 8));
  assert.deepEqual(shapeFromAnswers({ events: 3, condition: [{ event: 0, yes: true }], target: [{ event: 1, yes: true }, { event: 2, yes: true }], rule: 'OR' }), shape(1, 2, 6, 14));
  assert.deepEqual(shapeFromAnswers({ events: 3, condition: [{ event: 0, yes: true }, { event: 1, yes: true }], target: [{ event: 2, yes: false }] }), shape(3, 8, 4, 1));
  assert.throws(() => shapeFromAnswers({ events: 2, condition: [{ event: 0, yes: true }], target: [{ event: 0, yes: false }] }), /Invalid conditional/);
  assert.throws(() => shapeFromAnswers({ events: 4, condition: [{ event: 0, yes: true }, { event: 1, yes: true }], target: [{ event: 2, yes: true }, { event: 3, yes: true }] }), /Invalid conditional/);
});

test('shapeVector and shapeKey match the contract', () => {
  assert.deepEqual(shapeVector(shape(1, 2, 2, 2), 5n, 3n), { scope: 3, values: [3n, 0n, 3n, 5n] });
  assert.deepEqual(shapeVector(shape(1, 1, 2, 2), 5n, 3n), { scope: 3, values: [0n, 3n, 5n, 3n] });
  assert.deepEqual(shapeVector(shape(1, 2, 6, 8), 7n, 2n).values, [2n, 0n, 2n, 0n, 2n, 0n, 2n, 7n]);
  assert.throws(() => shapeVector(shape(1, 2, 2, 2), 0n, 0n), /Invalid conditional/);
  const expected = keccak256(encodeAbiParameters([{ type: 'uint32' }, { type: 'uint256' }, { type: 'uint32' }, { type: 'uint256' }], [1, 2n, 2, 2n]));
  assert.equal(shapeKey(shape(1, 2, 2, 2)), expected);
  assert.notEqual(shapeKey(shape(2, 2, 1, 2)), expected);
});

test('shapePayout matches the fixtures', () => {
  const five = row('state_five_b_given_a');
  for (const result of five.payouts)
    assert.equal(shapePayout(shape(1, 2, 2, 2), BigInt(five.shares), BigInt(five.priceAtoms), result.yesMask, result.voidMask),
      BigInt(result.atoms), result.result);
  assert.equal(five.payouts.find((p: any) => p.result === 'a_no').atoms, five.priceAtoms);
  assert.equal(shapePayout(shape(1, 2, 6, 8), 8n, 4n, 7, 4), 4n);
});

function interpolated(r: any) {
  const samples = r.samples.map(([p, c]: string[]) => [BigInt(p), BigInt(c)]);
  return async (price: bigint) => {
    if (price < samples[0][0] || price > samples.at(-1)[0]) throw Error('outside the sampled range');
    const upper = samples.findIndex(([p]: bigint[]) => p >= price);
    if (samples[upper][0] === price) return samples[upper][1];
    const [p0, c0] = samples[upper - 1], [p1, c1] = samples[upper];
    const scaled = c0 * (p1 - p0) + (c1 - c0) * (price - p0);
    return (scaled + (p1 - p0) - 1n) / (p1 - p0);
  };
}

test('solveConditionalPrice converges within five reads', async () => {
  for (const r of fixtures.filter((x: any) => x.fair !== null)) {
    let reads = 0;
    const quote = interpolated(r);
    const result = await solveConditionalPrice({ shares: BigInt(r.shares), fair: Number(r.before.given),
      conditionChance: Number(r.before.condition), quote: async (price: bigint) => { reads++; return quote(price); } });
    assert.ok(result.reads <= 5 && result.reads === reads, `${r.name} reads ${result.reads}`);
    const tolerance = result.price / 10000n + (result.price % 10000n ? 1n : 0n);
    assert.ok(result.cost <= result.price && result.price - result.cost <= (tolerance > 2n ? tolerance : 2n), r.name);
    assert.ok(result.price >= BigInt(r.fairAtoms) - 2n, `${r.name} ${result.price} below ${r.fairAtoms}`);
    assert.ok(result.price - BigInt(r.fairAtoms) <= 2n * (tolerance > 2n ? tolerance : 2n) + 2n, `${r.name} ${result.price} far above ${r.fairAtoms}`);
    assert.ok(result.price <= BigInt(r.shares));
  }
});

test('solveConditionalPrice starts at one half without chances and still converges', async () => {
  const r = row('state_b_given_a');
  const result = await solveConditionalPrice({ shares: BigInt(r.shares), fair: null, conditionChance: null, quote: interpolated(r) });
  assert.ok(result.reads <= 5 && result.cost <= result.price);
});

test('solveConditionalPrice refuses a too-certain conditional', async () => {
  const r = row('too_certain');
  await assert.rejects(solveConditionalPrice({ shares: BigInt(r.shares), fair: Number(r.before.given),
    conditionChance: Number(r.before.condition), quote: interpolated(r) }), { message: r.error });
  assert.equal(r.error, 'This conditional is too certain to buy');
});

test('solveConditionalPrice gives up after five reads', async () => {
  let reads = 0;
  await assert.rejects(solveConditionalPrice({ shares: 1_000_000n, fair: 0.5, conditionChance: 0.5,
    quote: async (price: bigint) => { reads++; return reads % 2 ? price + 10_000n : price - 10_000n; } }),
  { message: 'Conditional price unavailable. Refresh and retry.' });
  assert.equal(reads, 5);
});

test('conditionalCall accepts only bounded conditional calls', () => {
  const s = shape(1, 2, 2, 2);
  const call = (functionName: string, args: unknown[]) => encodeFunctionData({ abi: condPoolAbi, functionName, args } as any);
  const buy = call('buyConditional', [s, 1_000_000n, 600_000n, 1000n]);
  assert.equal(conditionalCall({ to: pool, data: buy, pool, events: 2 })?.name, 'buyConditional');
  assert.equal(conditionalCall({ to: pool.toUpperCase().replace('0X', '0x'), data: buy, pool, events: 2 })?.name, 'buyConditional');
  assert.equal(conditionalCall({ to: pool, data: call('sellConditional', [s, 1_000_000n, 1n, 1000n]), pool, events: 2 })?.name, 'sellConditional');
  assert.equal(conditionalCall({ to: pool, data: call('redeemConditional', [s]), pool, events: 2 })?.name, 'redeemConditional');
  const approve = encodeFunctionData({ abi: pilotCashAbi, functionName: 'approve', args: [pool, 2_000_000n] } as any);
  assert.equal(conditionalCall({ to: pilotCash, data: approve, pool, events: 2 })?.name, 'approve');
  const refused = [
    { to: pool, data: encodeFunctionData({ abi: condPoolAbi, functionName: 'factors' } as any) },
    { to: '0x' + '43'.repeat(20), data: buy },
    { to: pool, data: buy + '00' },
    { to: pool, data: call('buyConditional', [s, 1_000_000n, 1_000_001n, 1000n]) },
    { to: pool, data: call('buyConditional', [s, 21_000_000n, 600_000n, 1000n]) },
    { to: pool, data: call('buyConditional', [s, 1_000_000n, 0n, 1000n]) },
    { to: pool, data: call('buyConditional', [shape(1, 2, 1, 2), 1_000_000n, 600_000n, 1000n]) },
    { to: pool, data: call('buyConditional', [shape(1, 2, 4, 2), 1_000_000n, 600_000n, 1000n]) },
    { to: pool, data: call('sellConditional', [s, 0n, 0n, 1000n]) },
    { to: pilotCash, data: encodeFunctionData({ abi: pilotCashAbi, functionName: 'approve', args: ['0x' + '43'.repeat(20), 1n] } as any) },
    { to: pilotCash, data: encodeFunctionData({ abi: pilotCashAbi, functionName: 'approve', args: [pool, 100_000_001n] } as any) },
  ];
  for (const [i, input] of refused.entries()) assert.equal(conditionalCall({ ...input, pool, events: 2 }), null, String(i));
});
