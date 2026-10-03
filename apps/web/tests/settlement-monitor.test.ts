import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { decodeFunctionData, encodeFunctionResult, parseAbi } from 'viem';
import { pilotFixture, hash, pool, resolver } from './pilot-fixture.ts';
import { pilotPoolAbi, pilotCashAbi, resolverAbi } from '../shared/pilot.mjs';
import { checkSettlement } from '../server/settlement-monitor.mjs';
import { runSettlementCheck } from '../scripts/check-settlement.mjs';

const CASH = '0xa9012a055bd4e0edff8ce09f960291c09d5322dc';
// Multicall3, used by status for its single batched read: each inner call is answered by the same fixture.
const MULTICALL = '0xca11bde05977b3631167028862be2a173976ca11';
const multicall = parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)']);
function fixture(time = 3000) {
  const f = pilotFixture(time, 4);
  f.manifest.publication.mode = 'rehearsal';
  // Intentionally wrong local timing: the monitor must use contract reads.
  f.manifest.publication.draft.closesAt = 999_999;
  const empty = { phase: 0, proposal: 0, counter: 0, result: 0, asserter: pool, disputer: resolver,
    evidenceHash: hash, counterEvidenceHash: hash, challengeUntil: 0n, voteUntil: 0n, votes: [0, 0, 0] };
  const cases = Array.from({ length: 4 }, () => structuredClone(empty));
  const values: Record<string, any> = { closesAt: 2000n, eventCount: 4, assertionPeriod: 3600,
    collateral: CASH, funded: true, quorum: 2, observationEnds: 3000n, assertionDeadline: 6600n,
    delivered: false, resolved: false, requiredCollateral: 10n, balanceOf: 100n };
  const calls: any[] = [];
  const rpc = async (method: string, params: any[] = []) => {
    calls.push({ method, params });
    if (method === 'eth_call' && params[0].to === MULTICALL) {
      const inner = decodeFunctionData({ abi: multicall, data: params[0].data }).args[0] as any[];
      const rows = [];
      for (const c of inner) rows.push({ success: true, returnData: await rpc('eth_call', [{ to: c.target, data: c.callData }, params[1]]) });
      return encodeFunctionResult({ abi: multicall, functionName: 'aggregate3', result: rows });
    }
    if (method === 'eth_call') {
      const tx = params[0], abi = tx.to === resolver ? resolverAbi : tx.to === pool ? pilotPoolAbi : pilotCashAbi;
      try {
        const { functionName, args } = decodeFunctionData({ abi, data: tx.data });
        if (functionName === 'caseState') return encodeFunctionResult({ abi, functionName, result: cases[Number(args![0])] });
        if (functionName in values) return encodeFunctionResult({ abi, functionName, result: values[functionName] });
      } catch (error) { if (tx.to === resolver || tx.to === pool) throw error; }
    }
    return f.rpc(method, params);
  };
  return { ...f, rpc, cases, values, calls, now: () => time };
}
const codes = (result: any) => result.report.alerts.map((a: any) => a.code);

test('monitor uses verified on-chain times, pins reads and never requests a transaction or wallet', async () => {
  const f = fixture(), result = await checkSettlement(f);
  assert.equal(result.report.timing.closesAt, 2000);
  assert.equal(result.report.lifecycle, 'trading_closed');
  assert.equal(result.report.events[0].deadline, 6600);
  assert.ok(codes(result).includes('ASSERTION_WINDOW_OPEN'));
  assert.ok(f.calls.every(c => ['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call'].includes(c.method)));
  assert.ok(f.calls.filter(c => c.method === 'eth_call').every(c => c.params[1] === '0x64'));
});

test('assertion, challenge and voting boundaries match strict contract cutoffs', async () => {
  for (const [time, deadlineCode] of [[4799, null], [4800, 'DEADLINE_WITHIN_30_MINUTES'], [6000, 'DEADLINE_WITHIN_10_MINUTES'], [6600, null]] as const) {
    const f = fixture(time);
    f.cases[0] = { ...f.cases[0], phase: 1, proposal: 2, challengeUntil: 6600n };
    const result = await checkSettlement(f);
    const alert = result.report.alerts.filter((a: any) => a.event === 0);
    assert.ok(alert.some((a: any) => a.code === (time < 6600 ? 'ASSERTION_REVIEW_REQUIRED' : 'UNCHALLENGED_FINALIZATION_READY')));
    assert.deepEqual(alert.filter((a: any) => a.code.startsWith('DEADLINE_')).map((a: any) => a.code), deadlineCode ? [deadlineCode] : []);
    if (time === 6600) assert.match(result.report.events[0].action, /challenge window has closed/i);
  }
  const f = fixture(6600);
  f.cases[1] = { ...f.cases[1], phase: 2, proposal: 2, counter: 1, challengeUntil: 4000n, voteUntil: 6600n };
  const result = await checkSettlement(f);
  assert.ok(codes(result).includes('ASSERTION_TIMEOUT_READY'));
  assert.ok(codes(result).includes('VOTING_TIMEOUT_READY'));
  assert.ok(!codes(result).includes('REVIEWER_VOTES_REQUIRED'));
});

test('active disputes, all-final delivery and redemption readiness stay separate', async () => {
  const f = fixture(4000);
  f.cases[0] = { ...f.cases[0], phase: 2, proposal: 2, counter: 1, challengeUntil: 5000n, voteUntil: 7600n, votes: [1, 0, 0] };
  assert.ok(codes(await checkSettlement(f)).includes('REVIEWER_VOTES_REQUIRED'));
  f.cases.forEach(c => { c.phase = 3; c.result = 3; });
  const ready = await checkSettlement(f);
  assert.ok(codes(ready).includes('DELIVERY_READY'));
  assert.ok(!codes(ready).includes('SETTLEMENT_DELIVERED'));
  f.values.delivered = f.values.resolved = true;
  const settled = await checkSettlement({ ...f, previous: ready.checkpoint });
  assert.equal(settled.report.lifecycle, 'settled');
  assert.ok(codes(settled).includes('SETTLEMENT_DELIVERED'));
  assert.ok(!codes(await checkSettlement({ ...f, previous: settled.checkpoint })).includes('SETTLEMENT_DELIVERED'));
});

test('deficit, unfunded pools and inconsistent chain state cannot look ready', async () => {
  const f = fixture();
  f.values.requiredCollateral = 1000n;
  assert.ok(codes(await checkSettlement(f)).includes('COLLATERAL_DEFICIT'));
  f.values.funded = false;
  const unfunded = await checkSettlement(f);
  assert.ok(codes(unfunded).includes('POOL_NOT_FUNDED'));
  assert.ok(!codes(unfunded).includes('ASSERTION_WINDOW_OPEN'));
  f.values.resolved = true;
  await assert.rejects(checkSettlement(f), /Invalid settlement state/);
});

test('bad bindings, stale reads, reorg during observation and malformed state reject', async () => {
  const f = fixture();
  f.values.eventCount = 3;
  await assert.rejects(checkSettlement(f), /binding/);
  f.values.eventCount = 4;
  await assert.rejects(checkSettlement({ ...f, now: () => 3200 }), /Stale/);
  f.options.chain = 143n;
  await assert.rejects(checkSettlement(f), /network/);
  f.options.chain = 10143n;
  let reads = 0;
  await assert.rejects(checkSettlement({ ...f, rpc: async (m: string, p: any[]) => {
    if (m === 'eth_getBlockByNumber' && p[0] === '0x64' && ++reads === 2) return { hash: '0x' + 'aa'.repeat(32) };
    return f.rpc(m, p);
  } }), /snapshot changed/);
  f.cases[0].phase = 1; // Asserted without an outcome or deadline is invalid.
  await assert.rejects(checkSettlement(f), /timing/);
});

test('restart detects missed intervals and canonical changes without suppressing active assertion warnings', async () => {
  const f = fixture(4000);
  f.cases[0] = { ...f.cases[0], phase: 1, proposal: 2, challengeUntil: 6600n };
  const initial = await checkSettlement(f);
  const previous = structuredClone(initial.checkpoint);
  previous.checkedAt = 3600;
  previous.snapshot.blockNumber = '99';
  const rpc = async (m: string, p: any[]) => m === 'eth_getBlockByNumber' && p[0] === '0x63'
    ? { hash: '0x' + 'aa'.repeat(32) } : f.rpc(m, p);
  const changed = await checkSettlement({ ...f, rpc, previous });
  assert.ok(codes(changed).includes('CHECKPOINT_REORG'));
  assert.ok(codes(changed).includes('CHECK_GAP'));
  assert.ok(codes(changed).includes('ASSERTION_REVIEW_REQUIRED'));
  await assert.rejects(checkSettlement({ ...f, previous: { ...previous, identity: 'foreign pool' } }), /checkpoint/);
  await assert.rejects(checkSettlement({ ...f, previous: { ...previous, delivered: null } }), /checkpoint/);
  await assert.rejects(checkSettlement({ ...f, previous: { ...initial.checkpoint, checkedAt: 4100 } }), /clock moved backwards/);
  await assert.rejects(checkSettlement({ ...f, previous: { ...previous, snapshot: { ...previous.snapshot, blockNumber: '200' } } }), /checkpoint unavailable/);
});

test('wall-clock skew cannot fabricate a closed challenge window', async () => {
  const f = fixture(6599);
  f.cases[0] = { ...f.cases[0], phase: 1, proposal: 2, challengeUntil: 6600n };
  const result = await checkSettlement({ ...f, now: () => 6601 });
  assert.ok(codes(result).includes('ASSERTION_REVIEW_REQUIRED'));
  assert.ok(!codes(result).includes('UNCHALLENGED_FINALIZATION_READY'));
});

test('CLI retains the last good checkpoint on RPC failure, redacts secrets and resumes after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'flurbo-monitor-'));
  const f = fixture();
  const manifest = { ...f.manifest, publication: { ...f.manifest.publication, mode: 'official-releases' } };
  const env = { FLURBO_PILOT_MANIFEST_JSON: JSON.stringify(manifest), FLURBO_ALCHEMY_TESTNET_RPC_URL: 'https://monad-testnet.g.alchemy.com/v2/private-test-key' };
  const outputs: string[] = [];
  const request = async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    return Response.json({ jsonrpc: '2.0', id: body.id, result: await f.rpc(body.method, body.params) });
  };
  const options = { args: [], env, directory, now: f.now, output: (v: string) => outputs.push(v), request };
  try {
    // The retired September practice flag is refused rather than silently checking the pilot.
    assert.equal(await runSettlementCheck({ ...options, args: ['--rehearsal'] }), 2);
    assert.equal(await runSettlementCheck(options), 1);
    const name = (await readdir(directory)).find(p => p.endsWith('.checkpoint.json'))!;
    const saved = await readFile(join(directory, name), 'utf8');
    assert.equal(await runSettlementCheck({ ...options, request: async () => { throw new Error('private-test-key'); } }), 2);
    assert.equal(await readFile(join(directory, name), 'utf8'), saved);
    assert.equal(JSON.parse(outputs.at(-1)!).alerts[0].code, 'MONITOR_READ_FAILED');
    assert.ok(!outputs.join('').includes('private-test-key'));
    assert.equal(await runSettlementCheck(options), 1);
    // Corruption fails closed instead of erasing or silently replacing the checkpoint.
    await writeFile(join(directory, name), '{broken');
    assert.equal(await runSettlementCheck(options), 2);
    assert.equal(await readFile(join(directory, name), 'utf8'), '{broken');
    assert.ok(!(await readdir(directory)).some(p => p.endsWith('.lock')));
  } finally {
    assert.equal(dirname(directory), tmpdir()); assert.match(basename(directory), /^flurbo-monitor-/);
    await rm(directory, { recursive: true, force: true });
  }
});
