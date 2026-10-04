import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { autoAnswerRule, oracleAnswerWorker } from '../server/oracle-answer-worker.mjs';

const routes = JSON.parse(readFileSync(new URL('../../../config/oracle-markets.json', import.meta.url), 'utf8')).routes;
const key = `0x${'1'.repeat(64)}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

function fixture({ historical = false, beacon = true, noQualifying = false, lateFinality = false } = {}) {
  const rule = autoAnswerRule(routes[0]);
  const blocks = [
    { number: 0n, timestamp: BigInt(rule.target - 20), hash: hash(1), transactions: [] },
    { number: 1n, timestamp: BigInt(rule.target - 10), hash: hash(2), transactions: [] },
    { number: 2n, timestamp: BigInt(noQualifying || lateFinality ? rule.target - 6 : rule.target + 4), hash: hash(3), transactions: [hash(9)] },
    { number: 3n, timestamp: BigInt(noQualifying ? rule.target - 4 : rule.target + 16), hash: hash(4), transactions: [] },
  ];
  const memory = new Map<string, string>();
  const sends: any[] = [];
  const command = async (op: string, name: string, value?: string, ...options: string[]) => {
    if (op === 'GET') return memory.get(name) ?? null;
    if (op === 'SET') {
      if (options.includes('NX') && memory.has(name)) return null;
      memory.set(name, value || ''); return 'OK';
    }
    if (op === 'DEL') return memory.delete(name) ? 1 : 0;
    throw Error(`Unexpected Redis operation ${op}`);
  };
  const source = {
    getChainId: async () => 11155111,
    getBlock: async ({ blockTag, blockNumber }: any) => blockTag === 'finalized'
      ? blocks[3] : blocks[Number(blockNumber)],
    readContract: async ({ functionName, args }: any) => {
      const route = routes.find((item: any) => item.questionId === args[0]);
      if (functionName === 'getBond') return 0n;
      if (functionName === 'getMinBond') return BigInt(route.minBond);
      if (functionName === 'getOpeningTS') return rule.deadline;
      if (functionName === 'isFinalized' || functionName === 'isPendingArbitration') return false;
      if (functionName === 'getContentHash') return route.contentHash;
      throw Error(`Unexpected contract read ${functionName}`);
    },
    getBalance: async () => 1_000_000_000_000_000_000n,
    simulateContract: async (request: any) => ({ request }),
    getTransactionReceipt: async () => { const error = Error('pending'); error.name = 'TransactionReceiptNotFoundError'; throw error; },
  };
  const fetcher = async (url: string) => {
    if (!beacon) return { ok: false, status: 404 };
    const before = !lateFinality || !url.includes('/finality_checkpoints')
      || url.includes(`/${Math.floor((rule.deadline - 1655733600) / 12) - 1}/`);
    const checkpointRoot = before ? hash(8) : hash(7);
    const checkpointBlock = lateFinality && url.endsWith(hash(8)) ? blocks[2] : blocks[3];
    const data = url.endsWith('/genesis') ? { data: { genesis_time: '1655733600' } }
      : url.endsWith('/spec') ? { data: { SECONDS_PER_SLOT: '12' } }
        : url.includes('/finality_checkpoints')
          ? { execution_optimistic: false, data: { finalized: { root: checkpointRoot } } }
          : { execution_optimistic: false, data: { message: { body: { execution_payload: {
            block_number: String(checkpointBlock.number), block_hash: checkpointBlock.hash } } } } };
    return { ok: true, json: async () => data };
  };
  let clock = historical ? rule.deadline + 10 : rule.target + 20;
  const worker = oracleAnswerWorker({ routes, source, command, privateKey: key,
    rpcUrl: 'https://example.org', beaconUrl: historical ? 'https://beacon.example.org' : null,
    fetcher: fetcher as any, now: () => clock,
    walletClient: { writeContract: async (request: any) => {
      sends.push(request); return hash(sends.length + 20);
    } } });
  return { worker, source, sends, memory, rule, setClock(value: number) { clock = value; } };
}

test('only the published Sepolia block rules can use automatic answers', () => {
  assert.equal(autoAnswerRule(routes[0]).predicate, 'even');
  assert.equal(autoAnswerRule(routes[1]).predicate, 'hasTransaction');
  assert.throws(() => autoAnswerRule({ ...routes[0], publication: {
    ...routes[0].publication, events: [{ ...routes[0].publication.events[0], question: 'Who wins?' }],
  } }), /Unsupported automatic answer rule/);
});

test('live finalized observation is stored before the cutoff and answers both questions after opening', async () => {
  const f = fixture();
  await f.worker.tick();
  assert.equal(f.sends.length, 0);
  assert.equal([...f.memory.keys()].filter(name => name.endsWith(':observation')).length, 2);
  f.setClock(f.rule.deadline + 1);
  await f.worker.tick();
  assert.equal(f.sends.length, 2);
  assert.equal(f.sends[0].args[1], `0x${'0'.repeat(63)}1`);
  assert.equal(f.sends[1].args[1], `0x${'0'.repeat(63)}1`);
  assert.equal(f.sends[0].value, BigInt(routes[0].minBond));
  await f.worker.tick();
  assert.equal(f.sends.length, 2);
  assert.deepEqual(Object.values(f.worker.status().results), ['submitted', 'submitted']);
  f.setClock(f.rule.deadline + 1802);
  await f.worker.tick();
  assert.equal(f.sends.length, 2);
  assert.match(f.worker.status().lastError, /transaction missing; manual review required/);
});

test('historical finalized checkpoint can recover an observation after the cutoff', async () => {
  const f = fixture({ historical: true });
  await f.worker.tick();
  assert.equal(f.sends.length, 2);
  assert.equal(f.worker.status().lastError, null);
  const observation = JSON.parse([...f.memory].find(([name]) => name.endsWith(':observation'))![1]);
  assert.equal(observation.proof.mode, 'historical');
  assert.equal(observation.proof.checkpointRoot, hash(8));
});

test('missing historical finality stops submission after the cutoff', async () => {
  const f = fixture({ historical: true, beacon: false });
  await f.worker.tick();
  assert.equal(f.sends.length, 0);
  assert.match(f.worker.status().lastError, /Historical Sepolia finality unavailable/);
  assert.deepEqual(Object.values(f.worker.status().results), ['attention', 'attention']);
});

test('historical absence can produce Void only when the post-cutoff checkpoint also has no qualifying block', async () => {
  const f = fixture({ historical: true, noQualifying: true });
  await f.worker.tick();
  assert.equal(f.sends.length, 2);
  assert.equal(f.sends[0].args[1], `0x${'f'.repeat(64)}`);
  assert.equal(f.sends[1].args[1], `0x${'f'.repeat(64)}`);
});

test('a finality change around the cutoff requires review instead of an automatic Void', async () => {
  const f = fixture({ historical: true, lateFinality: true });
  await f.worker.tick();
  assert.equal(f.sends.length, 0);
  assert.match(f.worker.status().lastError, /finality changed near the cutoff/);
});

test('RPC errors cannot expose a credentialed endpoint in health status', async () => {
  const f = fixture();
  f.source.getChainId = async () => { throw Error('https://private.example.org/secret-token'); };
  await f.worker.tick();
  assert.equal(f.worker.status().lastError, 'Oracle answer source or transaction request failed');
});
