import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, keccak256, parseAbiParameters, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { courtAction, hybridCourtKeeper } from '../server/hybrid-court-keeper.mjs';
import { SEPOLIA_KLEROS, SEPOLIA_REALITY } from '../server/oracle-integration.mjs';
import { at, catalog } from './hybrid-catalog-fixture.ts';

const COURT = '0x90992fb4E15ce0C59aEFfb376460Fda4Ee19C879';
const zero = `0x${'0'.repeat(64)}`;
const yes = `0x${'0'.repeat(63)}1`;
const questionId = `0x${'a'.repeat(64)}`;
const keeperKey = `0x${'44'.repeat(32)}` as `0x${string}`;
const keeper = privateKeyToAccount(keeperKey).address;
const fee = 10n ** 16n;
const bond = 200000000000000n;

const court = (over: Record<string, unknown> = {}) => ({ court: COURT, disputeId: '7', period: 0,
  lastPeriodChange: 1000, timesPerPeriod: [30, 600, 600, 600], rounds: 1, drawn: 1, votesNeeded: 1,
  votesCast: 0, ruled: false, ...over });
const phase = (over: Record<string, unknown> = {}) => ({ phase: 0, lastPhaseChange: 1000, minStakingTime: 60,
  maxDrawingTime: 600, disputesWithoutJurors: 1, nextDelayed: 312, lastDelayed: 311, ...over });

test('staking phase executes delayed stakes first', () => {
  assert.deepEqual(courtAction({ now: 2000, court: court({ drawn: 0 }),
    phase: phase({ nextDelayed: 312, lastDelayed: 313 }), voteWaitSeconds: 86400 }),
  { kind: 'executeDelayedSetStakes', iterations: 2 });
  assert.equal(courtAction({ now: 2000, court: court({ drawn: 0 }),
    phase: phase({ nextDelayed: 10, lastDelayed: 500 }), voteWaitSeconds: 86400 }).iterations, 20);
});

test('staking phase passes when time and disputes allow', () => {
  const input = { court: court({ drawn: 0 }), voteWaitSeconds: 86400 };
  assert.deepEqual(courtAction({ ...input, now: 1060, phase: phase() }), { kind: 'passPhase' });
  assert.equal(courtAction({ ...input, now: 1059, phase: phase() }).kind, 'wait');
  assert.equal(courtAction({ ...input, now: 2000, phase: phase({ disputesWithoutJurors: 0 }) }).kind, 'wait');
});

test('generating phase passes', () => {
  assert.deepEqual(courtAction({ now: 2000, court: court({ drawn: 0 }), phase: phase({ phase: 1 }),
    voteWaitSeconds: 86400 }), { kind: 'passPhase' });
});

test('drawing phase draws remaining jurors', () => {
  assert.deepEqual(courtAction({ now: 2000, court: court({ drawn: 1, votesNeeded: 3 }),
    phase: phase({ phase: 2 }), voteWaitSeconds: 86400 }), { kind: 'drawJurors', iterations: 2 });
});

test('evidence period passes after its time once drawn', () => {
  const input = { court: court(), phase: phase({ phase: 2 }), voteWaitSeconds: 86400 };
  assert.deepEqual(courtAction({ ...input, now: 1030 }), { kind: 'passPeriod' });
  assert.equal(courtAction({ ...input, now: 1029 }).kind, 'wait');
  assert.deepEqual(courtAction({ ...input, now: 1001, court: court({ rounds: 2 }) }), { kind: 'passPeriod' });
});

test('vote period waits for the juror', () => {
  const voting = (over = {}) => court({ period: 2, lastPeriodChange: 1000, ...over });
  const input = { phase: phase({ phase: 2 }), voteWaitSeconds: 86400 };
  assert.equal(courtAction({ ...input, now: 1000 + 3600, court: voting() }).kind, 'wait');
  assert.deepEqual(courtAction({ ...input, now: 1100, court: voting({ votesCast: 1 }) }), { kind: 'passPeriod' });
  assert.deepEqual(courtAction({ ...input, now: 1000 + 86400, court: voting() }), { kind: 'passPeriod' });
});

test('appeal period passes after 600 s', () => {
  const appeal = court({ period: 3, lastPeriodChange: 1000 });
  const input = { phase: phase({ phase: 2 }), voteWaitSeconds: 86400, court: appeal };
  assert.deepEqual(courtAction({ ...input, now: 1600 }), { kind: 'passPeriod' });
  assert.equal(courtAction({ ...input, now: 1599 }).kind, 'wait');
});

test('execution executes the ruling', () => {
  const input = { now: 5000, phase: phase({ phase: 2 }), voteWaitSeconds: 86400 };
  assert.deepEqual(courtAction({ ...input, court: court({ period: 4 }) }), { kind: 'executeRuling' });
  assert.equal(courtAction({ ...input, court: court({ period: 4, ruled: true }) }).kind, 'wait');
});

function fixture(over: Record<string, any> = {}) {
  const { sourceNow = at + 3700, status = 0, best = zero, bondWei = bond, courtValues = {},
    observation = { questionId, outcome: 2, answer: yes, evidenceURI: 'https://flurbopm.singu.online/api/pilot/evidence/0x1',
      evidenceHash: `0x${'1'.repeat(64)}` }, finalizeTs = at + 3600 + 3600, proxyFee = fee,
    logs = [], balance = 10n ** 18n, chainId = 11155111, finalized = false, history = `0x${'4'.repeat(64)}`,
    realityBalance = 0n, code = '0x6080', votes = [] } = over;
  const pools = catalog(['reality', 'reality'], { keeper }).pools;
  const events: any[] = pools[0].prepared.draft.events;
  const values = new Map<string, string>();
  const command = async (op: string, name: string, value?: string, ...options: string[]) => {
    if (op === 'GET') return values.get(name) ?? null;
    if (op === 'SET') {
      if (options.includes('NX') && values.has(name)) return null;
      values.set(name, value || ''); return 'OK';
    }
    if (op === 'DEL') return values.delete(name) ? 1 : 0;
    throw Error(`Unexpected ${op}`);
  };
  if (observation) values.set(`flurbo:hybrid-answer:v1:${questionId}:observation`, JSON.stringify(observation));
  const writes: any[] = [];
  const puts: any[] = [];
  const dispute = { disputes: [0n, SEPOLIA_KLEROS, 2n ** 256n - 1n, 0n, 1000n, 1n, 0n, false],
    getDispute: [[1n], [0n], [0n], [0n], [0n], [0n]], getSubcourt: [[], [30n, 600n, 600n, 600n]],
    currentRuling: 0n, appealPeriod: [0n, 0n], appealCost: 0n, phase: 2, lastPhaseChange: 1000n,
    minStakingTime: 60n, maxDrawingTime: 600n, disputesWithoutJurors: 0n, nextDelayed: 312n,
    lastDelayed: 311n, ...courtValues };
  const source = {
    getChainId: async () => chainId,
    getBlock: async () => ({ timestamp: BigInt(sourceNow), number: 50n, hash: `0x${'8'.repeat(64)}` }),
    getBalance: async () => balance,
    getBlockNumber: async () => 120n,
    getBytecode: async () => code,
    getTransactionReceipt: async ({ hash }: any) => hash === events[0].source.questionTxHash || hash === events[1].source.questionTxHash
      ? { status: 'success', to: events[0].source.reality, blockNumber: 100n } : { status: 'success' },
    getLogs: async () => logs,
    simulateContract: async (request: any) => ({ request }),
    readContract: async ({ functionName, args = [] }: any) => {
      if (functionName === 'getVote') return votes[Number(args[2])] ?? [zeroAddress, zero, 0n, false];
      const second = `0x${'b'.repeat(64)}`;
      const item = events[args[0] === second || args[0] === BigInt(second) ? 1 : 0].source;
      const table: Record<string, unknown> = {
        getContentHash: item.contentHash, getArbitrator: item.arbitrator, getOpeningTS: BigInt(at + 3600),
        getTimeout: 3600n, getMinBond: 100000000000000n, getBond: bondWei, getFinalizeTS: BigInt(finalizeTs),
        getBestAnswer: best, getHistoryHash: history,
        isPendingArbitration: status > 0 && item === events[0].source, isFinalized: finalized, getDisputeFee: proxyFee,
        realitio: item.reality, balanceOf: realityBalance,
        arbitrationRequests: [item === events[0].source ? BigInt(status) : 0n, keeper, 7n, 0n],
        arbitrator: COURT, arbitratorExtraData: encodeAbiParameters(parseAbiParameters('uint256,uint256'), [0n, 1n]),
        getMultipliers: [3000n, 7000n, 5000n, 10000n], ...dispute };
      return table[functionName];
    },
  };
  const keeperWallet = { writeContract: async (request: any) => {
    writes.push({ functionName: request.functionName, args: request.args, value: request.value, address: request.address });
    return `0x${String(writes.length).repeat(64)}`; } };
  const evidence = { put: async (route: any, owner: string, input: any) => {
    puts.push({ route, owner, input });
    return { hash: `0x${'7'.repeat(64)}`, uri: 'https://flurbopm.singu.online/api/oracle/evidence/0x' + '7'.repeat(64) };
  } };
  const build = (extra: Record<string, unknown> = {}) => hybridCourtKeeper({ pools, source, command, evidence,
    rpcUrl: 'https://source.example', privateKey: keeperKey, keeperWallet, proxyCodeHash: keccak256('0x6080'), ...extra });
  return { build, writes, puts, values, events, source };
}

const names = (writes: any[]) => writes.map(write => write.functionName);

test('requests arbitration when the best answer contradicts the reader', async () => {
  const { build, writes } = fixture();
  await build().tick();
  assert.deepEqual(names(writes), ['requestArbitration']);
  assert.deepEqual(writes[0].args, [questionId, bond]);
  assert.equal(writes[0].value, fee);
  assert.equal(writes[0].address.toLowerCase(), SEPOLIA_KLEROS.toLowerCase());
});

test('no arbitration when answers agree, fee above cap, or window closing', async () => {
  const agree = fixture({ best: yes });
  await agree.build().tick();
  assert.deepEqual(agree.writes, []);
  const expensive = fixture({ proxyFee: 3n * 10n ** 16n });
  const worker = expensive.build();
  await worker.tick();
  assert.deepEqual(expensive.writes, []);
  assert.match(worker.status().lastError || '', /needs the arbitration fee/);
  const closing = fixture({ sourceNow: at + 3600 + 3600 - 30 });
  await closing.build().tick();
  assert.deepEqual(closing.writes, []);
  const unanswered = fixture({ bondWei: 0n });
  await unanswered.build().tick();
  assert.deepEqual(unanswered.writes, []);
});

test('submits reader evidence once per dispute', async () => {
  const { build, writes, puts } = fixture({ status: 1, sourceNow: 1010 });
  const worker = build();
  await worker.tick();
  assert.equal(puts.length, 1);
  assert.deepEqual(names(writes), ['submitEvidence']);
  assert.deepEqual(writes[0].args, [BigInt(questionId), 'https://flurbopm.singu.online/api/oracle/evidence/0x' + '7'.repeat(64)]);
  await worker.tick();
  assert.equal(puts.length, 1);
  assert.deepEqual(names(writes), ['submitEvidence']);
});

test('moves the court forward once evidence is filed', async () => {
  const { build, writes, values } = fixture({ status: 1, sourceNow: 1000 + 31,
    courtValues: { disputes: [0n, SEPOLIA_KLEROS, 2n ** 256n - 1n, 0n, 1000n, 1n, 0n, false] } });
  values.set(`flurbo:hybrid-court:v1:${questionId}:7:evidence`, `0x${'9'.repeat(64)}`);
  await build().tick();
  assert.deepEqual(names(writes), ['passPeriod']);
  assert.equal(writes[0].address.toLowerCase(), COURT.toLowerCase());
  assert.deepEqual(writes[0].args, [7n]);
});

test('reports a Ruled answer', async () => {
  const first = `0x${'5'.repeat(64)}`, last = `0x${'4'.repeat(64)}`;
  const logs = [
    { args: { answer: zero, history_hash: first, user: keeper, bond: 100000000000000n } },
    { args: { answer: yes, history_hash: last, user: keeper, bond } },
  ];
  const { build, writes } = fixture({ status: 2, logs });
  await build().tick();
  assert.deepEqual(names(writes), ['reportAnswer']);
  assert.deepEqual(writes[0].args, [questionId, first, yes, keeper]);
});

test('journal prevents duplicates', async () => {
  const { build, writes, values } = fixture();
  values.set(`flurbo:hybrid-court:v1:${questionId}:none:arbitrate`, 'preparing');
  await build().tick();
  assert.deepEqual(writes, []);
});

test('status masks errors', async () => {
  const { build } = fixture({ chainId: 1 });
  const worker = build();
  await worker.tick();
  assert.equal(worker.status().lastError, 'Hybrid court keeper chain mismatch');
  const failing = fixture();
  failing.source.getBlock = async () => { throw Error('request to https://secret.example/abc failed'); };
  const other = failing.build();
  await other.tick();
  assert.equal(other.status().lastError?.includes('secret'), false);
  assert.equal(other.status().lastError?.includes('Hybrid court keeper source or transaction request failed'), true);
  assert.equal(other.status().keeper, keeper);
});

const rulingLogs = [
  { args: { answer: zero, history_hash: `0x${'5'.repeat(64)}`, user: keeper, bond: 100000000000000n } },
  { args: { answer: yes, history_hash: `0x${'4'.repeat(64)}`, user: keeper, bond } },
];

test('refuses a proxy whose code differs from the verified Kleros proxy', async () => {
  const { build, writes } = fixture({ code: '0x6081' });
  const worker = build();
  await worker.tick();
  assert.deepEqual(writes, []);
  assert.match(worker.status().lastError || '', /Reality arbitrator is not a verified Kleros proxy/);
});

test('executes each court round after the ruling, then claims bonds', async () => {
  const { build, writes } = fixture({ status: 3, finalized: true, logs: rulingLogs,
    courtValues: { disputes: [3n, SEPOLIA_KLEROS, 2n ** 256n - 1n, 4n, 1000n, 3n, 0n, true],
      getDispute: [[1n, 3n], [0n, 0n], [0n, 0n], [1n, 3n], [2n, 0n], [0n, 0n]] } });
  await build().tick();
  assert.deepEqual(names(writes), ['execute', 'claimWinnings']);
  assert.equal(writes[0].address.toLowerCase(), COURT.toLowerCase());
  assert.deepEqual(writes[0].args, [7n, 1n, 6n]);
  assert.equal(writes[1].address.toLowerCase(), SEPOLIA_REALITY.toLowerCase());
  assert.equal(writes[1].args[0], `0x${'b'.repeat(64)}`);
  await build().tick();
  assert.deepEqual(names(writes), ['execute', 'claimWinnings', 'claimWinnings']);
  assert.equal(writes[2].args[0], questionId);
});

test('a final unchallenged question claims bonds once', async () => {
  const { build, writes } = fixture({ status: 0, finalized: true,
    logs: [{ args: { answer: yes, history_hash: `0x${'4'.repeat(64)}`, user: keeper, bond: 100000000000000n } }] });
  const worker = build();
  await worker.tick();
  assert.deepEqual(names(writes), ['claimWinnings', 'claimWinnings']);
  await worker.tick();
  assert.equal(writes.length, 2);
});

test('withdraws keeper Reality credit at the minimum', async () => {
  const funded = fixture({ realityBalance: 10n ** 14n });
  await funded.build().tick();
  assert.deepEqual(names(funded.writes), ['requestArbitration', 'withdraw']);
  assert.equal(funded.writes[1].address.toLowerCase(), SEPOLIA_REALITY.toLowerCase());
  const dust = fixture({ realityBalance: 10n ** 14n - 1n });
  await dust.build().tick();
  assert.deepEqual(names(dust.writes), ['requestArbitration']);
});

test("status shows the juror's unvoted seats in the vote period", async () => {
  const juror = `0x${'66'.repeat(20)}`;
  const { build, values } = fixture({ status: 1, sourceNow: 1100,
    courtValues: { disputes: [0n, SEPOLIA_KLEROS, 2n ** 256n - 1n, 2n, 1000n, 1n, 0n, false] },
    votes: [[juror, zero, 0n, false]] });
  values.set(`flurbo:hybrid-court:v1:${questionId}:7:evidence`, `0x${'9'.repeat(64)}`);
  const worker = build({ juror });
  await worker.tick();
  assert.equal(worker.status().juror, juror);
  const key = Object.keys(worker.status().cases)[0];
  assert.deepEqual(worker.status().cases[key].jurorVoteIds, [0]);
});
