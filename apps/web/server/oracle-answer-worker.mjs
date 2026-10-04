import { createWalletClient, defineChain, getAddress, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { realityAbi, SEPOLIA_REALITY, SEPOLIA_KLEROS } from './oracle-integration.mjs';

const sepolia = defineChain({ id: 11155111, name: 'Sepolia', nativeCurrency: {
  name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
rpcUrls: { default: { http: ['https://ethereum-sepolia-rpc.publicnode.com'] } } });
const pattern = /^Will the first canonical finalized Sepolia block with timestamp at or after (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ) (have an even block number|contain at least one transaction)\? Read Sepolia eth_getBlockByNumber\. VOID if no such finalized block is available by (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)\.$/;
const key = (questionId, suffix) => `flurbo:oracle-answer:v1:${questionId.toLowerCase()}:${suffix}`;
const validHash = value => /^0x[0-9a-fA-F]{64}$/.test(value || '');
const publicErrors = new Set([
  'Historical Sepolia finality requires FLURBO_SEPOLIA_BEACON_URL',
  'Sepolia finality changed near the cutoff; manual review required',
  'Source observation missed its deadline',
  'Observed Sepolia block changed',
  'Stored Sepolia answer does not match its block',
  'Reality question content changed',
  'Reality answer bond mismatch',
  'Oracle answer RPC is not Sepolia',
  'Sepolia answer signer needs ETH for bond and gas',
  'Sepolia answer submission uncertain; inspect the signer before retrying',
  'Sepolia answer transaction reverted; manual review required',
  'Sepolia answer transaction missing; manual review required',
  'Confirmed Sepolia answer has no bond; manual review required',
  'Invalid automatic answer transaction record',
  'Automatic answer observation conflict',
]);
const safeError = error => {
  const message = error instanceof Error ? error.message : '';
  return publicErrors.has(message) || /^Historical Sepolia finality unavailable \(\d{3}\)$/.test(message)
    ? message : 'Oracle answer source or transaction request failed';
};

export function autoAnswerRule(route) {
  const event = route?.publication?.events?.[route.eventIndex];
  const source = event?.source;
  const match = event?.question?.match(pattern);
  if (!match || source?.kind !== 'reality-sepolia'
    || source.questionText !== `${event.question}␟flurbo-poc␟en`
    || source.questionId?.toLowerCase() !== route.questionId?.toLowerCase()
    || source.reality?.toLowerCase() !== SEPOLIA_REALITY.toLowerCase()
    || source.arbitrator?.toLowerCase() !== SEPOLIA_KLEROS.toLowerCase())
    throw Error(`Unsupported automatic answer rule: ${route?.id || 'unknown'}`);
  const target = Date.parse(match[1]) / 1000;
  const deadline = Date.parse(match[3]) / 1000;
  if (!Number.isSafeInteger(target) || !Number.isSafeInteger(deadline)
    || deadline <= target || deadline - target > 86400 || event.observationEndsAt !== deadline)
    throw Error(`Invalid automatic answer window: ${route.id}`);
  return { target, deadline, predicate: match[2] === 'have an even block number' ? 'even' : 'hasTransaction' };
}

async function firstBlock(source, target, head) {
  if (Number(head.timestamp) < target) return null;
  let low = 0n, high = BigInt(head.number);
  while (low < high) {
    const middle = (low + high) / 2n;
    const block = await source.getBlock({ blockNumber: middle });
    if (Number(block.timestamp) < target) low = middle + 1n;
    else high = middle;
  }
  const block = await source.getBlock({ blockNumber: low });
  if (!validHash(block.hash) || Number(block.timestamp) < target || low > BigInt(head.number))
    throw Error('Finalized Sepolia block search failed');
  return block;
}

async function historicalHead(beaconUrl, source, target, deadline, fetcher) {
  if (!beaconUrl) throw Error('Historical Sepolia finality requires FLURBO_SEPOLIA_BEACON_URL');
  const read = async path => {
    const response = await fetcher(`${beaconUrl}${path}`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw Error(`Historical Sepolia finality unavailable (${response.status})`);
    return response.json();
  };
  const genesis = await read('/eth/v1/beacon/genesis');
  const spec = await read('/eth/v1/config/spec');
  const genesisTime = Number(genesis?.data?.genesis_time);
  const secondsPerSlot = Number(spec?.data?.SECONDS_PER_SLOT);
  if (!Number.isSafeInteger(genesisTime) || !Number.isSafeInteger(secondsPerSlot)
    || secondsPerSlot <= 0 || secondsPerSlot > 60) throw Error('Invalid Sepolia Beacon configuration');
  const baseSlot = Math.floor((deadline - genesisTime) / secondsPerSlot);
  if (!Number.isSafeInteger(baseSlot) || baseSlot < 1) throw Error('Invalid historical Sepolia slot');
  const checkpointAt = async slot => {
    const checkpoint = await read(`/eth/v1/beacon/states/${slot}/finality_checkpoints`);
    const root = checkpoint?.data?.finalized?.root;
    if (checkpoint?.execution_optimistic !== false || !validHash(root))
      throw Error('Historical Sepolia checkpoint is not verified');
    const beaconBlock = await read(`/eth/v2/beacon/blocks/${root}`);
    const number = beaconBlock?.data?.message?.body?.execution_payload?.block_number;
    const hash = beaconBlock?.data?.message?.body?.execution_payload?.block_hash;
    if (beaconBlock?.execution_optimistic !== false || !/^\d+$/.test(String(number)) || !validHash(hash))
      throw Error('Historical Sepolia execution block unavailable');
    const head = await source.getBlock({ blockNumber: BigInt(number) });
    if (head.hash?.toLowerCase() !== hash.toLowerCase()) throw Error('Historical Sepolia block hash mismatch');
    return { head, checkpointRoot: root, checkpointSlot: slot };
  };
  const before = await checkpointAt(baseSlot - 1);
  if (Number(before.head.timestamp) >= target) return before;
  const after = await checkpointAt(baseSlot + 1);
  if (Number(after.head.timestamp) >= target)
    throw Error('Sepolia finality changed near the cutoff; manual review required');
  return after;
}

function outcome(rule, block) {
  if (!block) return 'void';
  if (rule.predicate === 'even') return BigInt(block.number) % 2n === 0n ? 'yes' : 'no';
  if (!Array.isArray(block.transactions)) throw Error('Sepolia transaction list unavailable');
  return block.transactions.length > 0 ? 'yes' : 'no';
}

const answerBytes = { no: `0x${'0'.repeat(64)}`, yes: `0x${'0'.repeat(63)}1`, void: `0x${'f'.repeat(64)}` };

export function oracleAnswerWorker({ routes, source, command, rpcUrl, privateKey,
  beaconUrl = null, fetcher = fetch, now = () => Math.floor(Date.now() / 1000),
  intervalMs = 30_000, walletClient = null }) {
  if (!Array.isArray(routes) || !routes.length || typeof command !== 'function'
    || !/^0x[0-9a-fA-F]{64}$/.test(privateKey || '') || !rpcUrl?.startsWith('https:')
    || beaconUrl && !/^https:\/\/[^/?#]+(?:\/[^?#]*)?$/.test(beaconUrl))
    throw Error('Oracle answer worker configuration incomplete');
  const rules = routes.map(route => ({ route, rule: autoAnswerRule(route) }));
  const account = privateKeyToAccount(privateKey);
  if (routes.some(route => route.relay.toLowerCase() === account.address.toLowerCase()))
    throw Error('Oracle answer signer must differ from the Monad relay');
  const wallet = walletClient || createWalletClient({ account, chain: sepolia,
    transport: http(rpcUrl, { timeout: 20_000 }) });
  let timer = null, running = false, cycles = 0, lastFinishedAt = null, lastError = null;
  const results = new Map();
  const errors = new Map(), retryAt = new Map();

  async function observe(route, rule, clock) {
    const saved = await command('GET', key(route.questionId, 'observation'));
    if (saved) return JSON.parse(saved);
    if (clock < rule.target) return null;
    let head, proof;
    if (clock <= rule.deadline) {
      head = await source.getBlock({ blockTag: 'finalized' });
      if (now() > rule.deadline) throw Error('Source observation missed its deadline');
      if (Number(head.timestamp) < rule.target) return null;
      proof = { mode: 'live', observedAt: now(), finalizedHead: String(head.number) };
    } else {
      const historical = await historicalHead(beaconUrl, source, rule.target, rule.deadline, fetcher);
      head = historical.head;
      proof = { mode: 'historical', checkpointRoot: historical.checkpointRoot,
        checkpointSlot: historical.checkpointSlot, finalizedHead: String(head.number) };
    }
    const block = await firstBlock(source, rule.target, head);
    const answer = outcome(rule, block);
    if (answer === 'void' && clock <= rule.deadline) return null;
    const observation = { schema: 'flurbo.oracle-observation.v1', questionId: route.questionId,
      target: rule.target, deadline: rule.deadline, answer, proof,
      blockNumber: block ? String(block.number) : null, blockHash: block?.hash || null,
      blockTimestamp: block ? Number(block.timestamp) : null,
      transactionCount: block?.transactions?.length ?? null };
    await command('SET', key(route.questionId, 'observation'), JSON.stringify(observation), 'NX');
    const stored = JSON.parse(await command('GET', key(route.questionId, 'observation')));
    if (stored.questionId?.toLowerCase() !== route.questionId.toLowerCase()
      || stored.target !== rule.target || stored.deadline !== rule.deadline)
      throw Error('Automatic answer observation conflict');
    return stored;
  }

  async function answer(route, observation, clock) {
    if (observation.blockNumber !== null) {
      const block = await source.getBlock({ blockNumber: BigInt(observation.blockNumber) });
      if (block.hash?.toLowerCase() !== observation.blockHash?.toLowerCase())
        throw Error('Observed Sepolia block changed');
      if (outcome(autoAnswerRule(route), block) !== observation.answer)
        throw Error('Stored Sepolia answer does not match its block');
    }
    const address = getAddress(route.reality), args = [route.questionId];
    const [bond, minBond, opening, finalized, pending, contentHash] = await Promise.all([
      source.readContract({ address, abi: realityAbi, functionName: 'getBond', args }),
      source.readContract({ address, abi: realityAbi, functionName: 'getMinBond', args }),
      source.readContract({ address, abi: realityAbi, functionName: 'getOpeningTS', args }),
      source.readContract({ address, abi: realityAbi, functionName: 'isFinalized', args }),
      source.readContract({ address, abi: realityAbi, functionName: 'isPendingArbitration', args }),
      source.readContract({ address, abi: realityAbi, functionName: 'getContentHash', args }),
    ]);
    if (contentHash?.toLowerCase() !== route.contentHash?.toLowerCase())
      throw Error('Reality question content changed');
    if (bond > 0n || finalized || pending) return 'already_answered';
    if (clock < Number(opening)) return 'waiting_open';
    const existing = await command('GET', key(route.questionId, 'transaction'));
    if (existing) {
      if (existing === 'preparing') return 'submission_uncertain';
      const record = JSON.parse(existing);
      if (!validHash(record?.hash) || !Number.isSafeInteger(record?.sentAt))
        throw Error('Invalid automatic answer transaction record');
      try {
        const receipt = await source.getTransactionReceipt({ hash: record.hash });
        if (receipt.status !== 'success') throw Error('Sepolia answer transaction reverted; manual review required');
        if (clock - record.sentAt > 300) throw Error('Confirmed Sepolia answer has no bond; manual review required');
        return 'confirming';
      } catch (error) {
        if (error?.name === 'TransactionReceiptNotFoundError') {
          if (clock - record.sentAt > 1800) throw Error('Sepolia answer transaction missing; manual review required');
          return 'submitted';
        }
        throw error;
      }
    }
    const value = BigInt(minBond);
    if (value <= 0n || value !== BigInt(route.minBond)) throw Error('Reality answer bond mismatch');
    const balance = await source.getBalance({ address: account.address });
    if (balance <= value) throw Error('Sepolia answer signer needs ETH for bond and gas');
    const request = await source.simulateContract({ address, abi: realityAbi,
      functionName: 'submitAnswer', args: [route.questionId, answerBytes[observation.answer], 0n],
      value, account });
    const lock = key(route.questionId, 'transaction');
    if (await command('SET', lock, 'preparing', 'NX') !== 'OK') return 'submission_uncertain';
    try {
      const hash = await wallet.writeContract({ ...request.request, account, chain: sepolia });
      await command('SET', lock, JSON.stringify({ hash, sentAt: clock }));
      return 'submitted';
    } catch (error) { throw Error('Sepolia answer submission uncertain; inspect the signer before retrying', { cause: error }); }
  }

  async function tick() {
    if (running) return;
    running = true; cycles++;
    try {
      if (await source.getChainId() !== 11155111) throw Error('Oracle answer RPC is not Sepolia');
      const clock = now();
      for (const { route, rule } of rules) {
        if (clock < (retryAt.get(route.id) || 0)) continue;
        try {
          if (clock > rule.deadline && !await command('GET', key(route.questionId, 'observation'))) {
            const bond = await source.readContract({ address: getAddress(route.reality), abi: realityAbi,
              functionName: 'getBond', args: [route.questionId] });
            if (bond > 0n) { results.set(route.id, 'already_answered');
              errors.delete(route.id); retryAt.delete(route.id); continue; }
          }
          const observation = await observe(route, rule, clock);
          results.set(route.id, observation ? await answer(route, observation, clock) : 'waiting_source');
          errors.delete(route.id); retryAt.delete(route.id);
        } catch (error) {
          const message = safeError(error);
          results.set(route.id, 'attention');
          if (errors.get(route.id) !== message) console.error(`Oracle answer ${route.id}: ${message}`);
          errors.set(route.id, message); retryAt.set(route.id, clock + 600);
        }
      }
      lastError = [...errors].map(([id, message]) => `${id}: ${message}`).join('; ') || null;
    } catch (error) {
      lastError = safeError(error);
      console.error(lastError);
    } finally { running = false; lastFinishedAt = new Date().toISOString(); }
  }
  return { tick,
    start() { if (!timer) { timer = setInterval(() => { void tick(); }, intervalMs);
      timer.unref(); void tick(); } },
    stop() { if (timer) clearInterval(timer); timer = null; },
    status() { return { enabled: Boolean(timer), running, cycles, lastFinishedAt, lastError,
      signer: account.address, routes: routes.length, results: Object.fromEntries(results) }; },
  };
}
