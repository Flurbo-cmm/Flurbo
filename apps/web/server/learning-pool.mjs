import {rpcFetch} from './rpc-capacity.mjs';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { encodeFunctionData, decodeFunctionResult } from 'viem';
import { TESTNET, testnetRpcHost } from './network.mjs';
import { poolAbi, cashAbi, engineAbi } from '../shared/learning-contracts.mjs';
export { poolAbi, cashAbi, engineAbi };

const digest = data => createHash('sha256').update(data).digest('hex');
const wire = value => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item));
const root = fileURLToPath(new URL('../../../', import.meta.url));
const OPERATOR = '0xf1fea08ebba92ed342acc5639db312c3694bc391';
const POOL = '0x094ed5f95188c222a61c27cae24b068120a52dd4';

function child(file, args, input, limit, signal) {
  return new Promise((resolve, reject) => {
    const process = execFile(file, args, { cwd: root, timeout: 12_000, maxBuffer: limit, windowsHide: true, signal,
      encoding: 'utf8', env: globalThis.process.platform === 'win32' ? { SystemRoot: globalThis.process.env.SystemRoot } : {} },
    (error, stdout) => error ? reject(new Error('Learning calculation rejected or unavailable')) : resolve(stdout));
    process.stdin.on('error', () => {});
    process.stdin.end(input || '');
  });
}

export async function loadLearningModel(binary = fileURLToPath(new URL('../../../bin/flurbo-learning-model', import.meta.url))) {
  const output = await child(binary, [], '', 16_000);
  const model = JSON.parse(output);
  if (model.schema !== 'flurbo.ising-model.v1' || model.events !== 8 || !Array.isArray(model.parameters) || model.parameters.length !== 36 ||
      model.parameters.some((p, index) => typeof p !== 'string' || !/^-?\d+\.\d+e[+-]?\d+$/.test(p) || !Number.isFinite(Number(p)) || Math.abs(Number(p)) > .1 ||
        ![0, 1, 8].includes(index) && Number(p) !== 0) || !model.source?.startsWith('synthetic-testnet-v1:')) throw new Error('Invalid synthetic model');
  return { model, binarySha256: digest(await readFile(binary)), outputSha256: digest(output) };
}

export async function buildHostedProposal(input, python = globalThis.process.env.PYTHON || 'python3', signal) {
  return JSON.parse(await child(python, ['scripts/hosted_learning_proposal.py'], JSON.stringify(input), 256_000, signal));
}

export function validateLearningManifest(m) {
  if (m.status !== 'verified_learning_snapshot' || m.environment !== 'public_testnet' || m.chain_id !== 10143 ||
      m.pool !== POOL || m.cash !== TESTNET.cash || m.updater !== OPERATOR || m.operator !== OPERATOR || m.resolver !== OPERATOR ||
      m.event_count !== 8 || m.liquidity_atoms !== 10_000_000 || m.max_bias_movement_atoms !== 2_000_000 ||
      m.epoch_funding_limit_atoms !== 10_000_000 || m.epoch_seconds !== 3600 || m.min_update_interval_seconds !== 60 ||
      m.rules_hash !== '0x89ccd66da707a465b629659659ed31c9e084f3a87e295bcbfa3033039dccc362' ||
      !Number.isSafeInteger(m.closes_at) || !Number.isSafeInteger(m.verified_block) ||
      !/^0x[0-9a-f]{64}$/.test(m.verified_block_hash)) throw new Error('Unverified learning deployment');
  for (const key of ['pool', 'pricing_engine', 'base_token_factory']) {
    if (!/^0x[0-9a-f]{40}$/.test(m[key]) || !/^[0-9a-f]{64}$/.test(m.runtime_evidence?.[key]?.runtime_sha256)) throw new Error('Missing learning runtime evidence');
  }
  return m;
}

// No generic RPC proxy: only these four read methods can leave this service.
export function learningRpc(url, fetcher = fetch) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.port ||
      !testnetRpcHost(parsed.hostname)) throw new Error('Public testnet RPC required');
  let id = 0;
  return async (calls, { signal } = {}) => {
    const output = [];
    for (let start = 0; start < calls.length; start += 10) {
      const batch = calls.slice(start, start + 10).map(([method, params]) => {
        if (!['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call'].includes(method)) throw new Error('Read-only learning RPC');
        return { jsonrpc: '2.0', id: ++id, method, params };
      });
      const response = await rpcFetch(fetcher,url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000) });
      if (!response.ok) throw new Error('Learning RPC unavailable');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 1_000_000) throw new Error('Learning RPC response too large');
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      const rows = JSON.parse(raw);
      if (!Array.isArray(rows) || rows.length !== batch.length || new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('Invalid RPC batch');
      for (const call of batch) {
        const row = rows.find(item => item.id === call.id);
        if (!row || row.jsonrpc !== '2.0' || row.error || !Object.hasOwn(row, 'result')) throw new Error('Learning RPC rejected read');
        output.push(row.result);
      }
    }
    return output;
  };
}

export function learningService({ manifest, rpc, modelReport, builder = (input, signal) => buildHostedProposal(input, undefined, signal), now = () => Date.now() }) {
  const m = validateLearningManifest(manifest);
  const read = (to, abi, functionName, args, tag, from) => ['eth_call', [{ to, data: encodeFunctionData({ abi, functionName, args }), ...(from ? { from } : {}) }, tag]];
  const decode = (abi, functionName, value) => decodeFunctionResult({ abi, functionName, data: value });
  const names = ['revision', 'lastUpdateAt', 'updateCount', 'fundingEpoch', 'epochFundingSpent', 'pricingReserve', 'actualRequiredCollateral', 'funded', 'resolved', 'factors', 'biasFactors'];
  const freshness = block => {
    if (!/^0x[0-9a-f]{64}$/i.test(block?.hash || '') || !/^0x[0-9a-f]+$/i.test(block.number || '') || !/^0x[0-9a-f]+$/i.test(block.timestamp || '')) throw new Error('Invalid learning snapshot');
    const age = Math.floor(now() / 1000) - Number(BigInt(block.timestamp));
    if (age < -15 || age > 180) throw new Error('Learning snapshot is stale');
  };
  const operation = () => {
    const signal = AbortSignal.timeout(25_000);
    return { signal, readRpc: calls => rpc(calls, { signal }) };
  };
  async function unchanged(block, readRpc) {
    const [head, latest] = await readRpc([['eth_getBlockByNumber', [block.number, false]], ['eth_getBlockByNumber', ['latest', false]]]);
    freshness(latest);
    if (head?.hash !== block.hash || head?.timestamp !== block.timestamp || latest?.number === undefined ||
        BigInt(latest.number) < BigInt(block.number) || Number(BigInt(latest.timestamp) - BigInt(block.timestamp)) > 30) throw new Error('Learning snapshot changed or expired. Refresh the review.');
  }
  async function snapshot(readRpc) {
    const [chain, block, anchor] = await readRpc([['eth_chainId', []], ['eth_getBlockByNumber', ['latest', false]],
      ['eth_getBlockByNumber', ['0x' + m.verified_block.toString(16), false]]]);
    if (chain !== '0x279f' || anchor?.hash !== m.verified_block_hash) throw new Error('Learning network identity mismatch');
    freshness(block);
    const contracts = ['pool', 'pricing_engine', 'base_token_factory'];
    const rows = await readRpc([...contracts.map(key => ['eth_getCode', [m[key], block.number]]),
      ...names.map(name => read(m.pool, poolAbi, name, [], block.number)),
      read(m.cash, cashAbi, 'balanceOf', [m.pool], block.number), read(m.cash, cashAbi, 'balanceOf', [OPERATOR], block.number),
      read(m.cash, cashAbi, 'allowance', [OPERATOR, m.pool], block.number)]);
    contracts.forEach((key, index) => {
      if (!/^0x(?:[0-9a-f]{2})+$/i.test(rows[index]) || digest(Buffer.from(rows[index].slice(2), 'hex')) !== m.runtime_evidence[key].runtime_sha256) throw new Error('Learning contract code mismatch');
    });
    const state = Object.fromEntries(names.map((name, index) => [name, decode(poolAbi, name, rows[3 + index])]));
    const poolCash = decode(cashAbi, 'balanceOf', rows.at(-3)), operatorCash = decode(cashAbi, 'balanceOf', rows.at(-2));
    const allowance = decode(cashAbi, 'allowance', rows.at(-1));
    const covered = poolCash >= state.pricingReserve && poolCash >= state.actualRequiredCollateral;
    const snap = wire({ schema: 'flurbo.funded-snapshot.v1', pool: m.pool, chainId: '10143', events: 8, decimals: 6,
      order: [0, 1, 2, 3, 4, 5, 6, 7], liquidity: '10000000', maxBiasMovement: '2000000',
      blockNumber: BigInt(block.number), blockHash: block.hash, timestamp: BigInt(block.timestamp), closesAt: String(m.closes_at),
      revision: state.revision, factors: state.factors.map(f => ({ scope: String(f.scope), values: f.values })),
      biasFactors: state.biasFactors.map(f => ({ scope: String(f.scope), values: f.values })) });
    await unchanged(block, readRpc);
    return { block, state, snap, poolCash, operatorCash, allowance, covered };
  }
  let stateCache, inflight, busy = false, lastPreparation = -Infinity;
  return {
    async status() {
      if (stateCache && now() - stateCache.at < 10_000) return stateCache.value;
      if (inflight) return inflight;
      inflight = (async () => {
        const s = await snapshot(operation().readRpc);
        const value = wire({ schema: 'flurbo.learning-pool.v1', environment: 'public_testnet', chainId: 10143,
          pool: m.pool, updater: OPERATOR, block: s.snap.blockNumber, timestamp: s.snap.timestamp, closesAt: m.closes_at,
          revision: s.state.revision, updates: s.state.updateCount, collateralAtoms: s.poolCash, reserveAtoms: s.state.pricingReserve,
          covered: s.covered, open: s.state.funded && !s.state.resolved && Number(s.snap.timestamp) < m.closes_at,
          modelReady: Boolean(modelReport()), synthetic: true, changesExecutablePrices: false });
        stateCache = { at: now(), value }; return value;
      })();
      try { return await inflight; } finally { inflight = null; }
    },
    async prepare() {
      if (busy || now() - lastPreparation < 15_000) throw new Error('Wait before preparing another proposal');
      busy = true; lastPreparation = now();
      try {
        const report = modelReport();
        if (!report) throw new Error('Synthetic Rust model unavailable');
        const { readRpc, signal } = operation();
        const s = await snapshot(readRpc), timestamp = BigInt(s.snap.timestamp);
        if (!s.state.funded || s.state.resolved || !s.covered || Number(timestamp) >= m.closes_at - 60) throw new Error('Learning market is closed or not covered');
        if (s.state.updateCount > 0n && timestamp < s.state.lastUpdateAt + 60n) throw new Error('Update cooldown is active');
        const deadline = String(Math.min(Math.floor(now() / 1000) + 300, m.closes_at - 1));
        const draft = await builder({ model: report.model, snapshot: s.snap, maxFunding: '1000000', deadline }, signal);
        const p = draft.proposal;
        if (draft.schema !== 'flurbo.unsigned-learning-proposal.v1' || p?.chainId !== '10143' || p.pool !== m.pool ||
            p.expectedRevision !== s.snap.revision || p.deadline !== deadline || p.maxFunding !== '1000000' || !Array.isArray(p.bias)) throw new Error('Invalid proposal output');
        if (JSON.stringify(p.bias) === JSON.stringify(s.snap.biasFactors)) throw new Error('This synthetic model is already applied');
        const marketValue = { events: 8, liquidity: 10_000_000n, decimals: 6, factors: s.state.factors, order: s.snap.order };
        const bias = p.bias.map(f => ({ scope: Number(f.scope), values: f.values.map(BigInt) }));
        const values = await readRpc([read(m.pricing_engine, engineAbi, 'reserve', [marketValue, bias], s.block.number),
          read(m.pool, poolAbi, 'quoteBuy', [3, 8n, 1_000_000n], s.block.number),
          read(m.pricing_engine, engineAbi, 'quote', [marketValue, bias, 3, 8n, 1_000_000n, true], s.block.number)]);
        const reserve = decode(engineAbi, 'reserve', values[0]);
        const needed = reserve > s.poolCash ? reserve - s.poolCash : 0n;
        const spent = s.state.fundingEpoch === timestamp / 3600n ? s.state.epochFundingSpent : 0n;
        if (needed > 1_000_000n || spent + needed > 10_000_000n || s.operatorCash < needed) throw new Error('Update exceeds funding policy or operator balance');
        p.maxFunding = needed.toString();
        const args = [{ chainId: 10143n, pool: m.pool, expectedRevision: BigInt(p.expectedRevision), deadline: BigInt(deadline), maxFunding: needed, bias }];
        const updateData = encodeFunctionData({ abi: poolAbi, functionName: 'updateBias', args });
        const needsApproval = s.allowance < needed;
        const transaction = { chainId: 10143, from: OPERATOR, to: needsApproval ? m.cash : m.pool, value: '0x0',
          data: needsApproval ? encodeFunctionData({ abi: cashAbi, functionName: 'approve', args: [m.pool, needed] }) : updateData };
        const [simulation] = await readRpc([['eth_call', [{ from: transaction.from, to: transaction.to, data: transaction.data }, s.block.number]]]);
        const result = decode(needsApproval ? cashAbi : poolAbi, needsApproval ? 'approve' : 'updateBias', simulation);
        if (needsApproval ? result !== true : result !== needed) throw new Error('Unexpected simulation result');
        await unchanged(s.block, readRpc);
        const [latestRevision] = await readRpc([read(m.pool, poolAbi, 'revision', [], 'latest')]);
        if (decode(poolAbi, 'revision', latestRevision) !== BigInt(s.snap.revision) || Math.floor(now() / 1000) >= Number(deadline)) throw new Error('Proposal changed or expired during preparation');
        return wire({ schema: 'flurbo.learning-review.v1', synthetic: true, changesExecutablePrices: false,
          generatedAt: new Date(now()).toISOString(), expiresAt: Number(deadline), snapshot: s.snap, proposal: p,
          model: report, modelSha256: draft.modelSha256, snapshotSha256: draft.snapshotSha256,
          quantizationBound: draft.diagnostics.totalVariationUpperBound, movementAtoms: draft.diagnostics.movementBoundAtoms,
          reserveAfterAtoms: reserve, fundingAtoms: needed, quoteBeforeAtoms: decode(poolAbi, 'quoteBuy', values[1]),
          quoteAfterAtoms: decode(engineAbi, 'quote', values[2])[0].collateral,
          action: needsApproval ? 'approval_required' : 'update_simulated', updateSimulated: !needsApproval,
          unsignedNextTransaction: transaction, unsignedUpdateData: updateData,
          notice: 'Read-only preparation. No transaction submitted. Approval must be followed by a fresh proposal and exact update simulation. Revalidate the deadline, revision and funding before signing.' });
      } finally { busy = false; }
    },
  };
}
