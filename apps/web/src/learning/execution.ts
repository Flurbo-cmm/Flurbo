import { decodeEventLog, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, toEventSelector, type Hex } from 'viem';
import { cashAbi, learningDeployment as deployment, poolAbi, updateParameters } from '../../shared/learning-contracts.mjs';

export class LearningError extends Error {}
export type Provider = { request(input: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: () => void): void; removeListener?(event: string, handler: () => void): void };
export type Review = { schema: string; expiresAt: number; generatedAt: string; action: string; updateSimulated: boolean;
  fundingAtoms: string; reserveAfterAtoms: string; quoteBeforeAtoms: string; quoteAfterAtoms: string; movementAtoms: string;
  modelSha256: string; snapshotSha256: string; quantizationBound: string;
  snapshot: { pool: string; chainId: string; blockNumber: string; blockHash: string; timestamp: string; revision: string };
  proposal: { chainId: string; pool: string; expectedRevision: string; deadline: string; maxFunding: string;
    bias: { scope: string; values: string[] }[] };
  unsignedNextTransaction: { chainId: number; from: string; to: string; value: string; data: string };
  unsignedUpdateData: string; notice: string };
export type Pending = { version: 1; review: Review; nonce: string; hash: string | null; startedAt: number };
export const pendingKey = 'flurbo.learning.pending.v1';
const hex = (value: bigint) => `0x${value.toString(16)}` as Hex;
const address = (value: string) => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{40}$/i.test(value)) throw new LearningError('Invalid review address.');
  return value.toLowerCase() as Hex;
};
const uint = (value: string, bits = 256) => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) >= 1n << BigInt(bits)) throw new LearningError('Invalid review amount.');
  return BigInt(value);
};
const rpcNumber = (value: unknown, source: string) => {
  // Some injected wallets return the pending nonce as a JS number. Convert only
  // exact unsigned integers; never round an unsafe value before signing.
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value !== 'string' || !/^0x[0-9a-f]{1,64}$/i.test(value)) {
    const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    throw new LearningError(`Wallet returned an invalid ${source} (${kind}); expected a hexadecimal integer or a nonnegative safe integer. Reconnect and retry the check.`);
  }
  return BigInt(value);
};
async function request(provider: Provider, method: string, params: unknown[] = []) {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([provider.request({ method, params }), new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LearningError('Wallet read timed out. Nothing was submitted by this check.')), 15_000);
  })]); } finally { clearTimeout(timer!); }
}

export function validateReview(review: Review, now = Date.now(), tracking = false) {
  const p = review.proposal, s = review.snapshot, tx = review.unsignedNextTransaction;
  const approval = review.action === 'approval_required';
  if (review.schema !== 'flurbo.learning-review.v1' || !['approval_required', 'update_simulated'].includes(review.action) ||
      review.updateSimulated !== !approval || p.chainId !== '10143' || s.chainId !== '10143' ||
      address(p.pool) !== deployment.pool || address(s.pool) !== deployment.pool || p.expectedRevision !== s.revision ||
      uint(p.maxFunding, 128) > 1_000_000n || p.maxFunding !== review.fundingAtoms ||
      uint(review.movementAtoms, 128) > 2_000_000n || Number(uint(p.deadline)) !== review.expiresAt ||
      review.expiresAt >= deployment.closes_at || uint(p.deadline) <= uint(s.timestamp) ||
      uint(p.deadline) - uint(s.timestamp) > 480n || !/^0x[0-9a-f]{64}$/i.test(s.blockHash) ||
      !Array.isArray(p.bias) || p.bias.length > 64) throw new LearningError('Proposal does not match this learning pool or its limits.');
  uint(s.blockNumber); uint(s.revision); uint(review.reserveAfterAtoms, 128);
  if (!tracking && (!Number.isFinite(Date.parse(review.generatedAt)) || now < Date.parse(review.generatedAt) - 15_000 ||
      now >= review.expiresAt * 1000 || now - Date.parse(review.generatedAt) > 300_000)) throw new LearningError('Review expired. Prepare a fresh proposal.');
  let previous = 0;
  const bias = p.bias.map(f => {
    const scope = Number(uint(f.scope, 32)), width = scope.toString(2).replace(/0/g, '').length;
    if (scope <= previous || scope > 255 || width > 3 || !Array.isArray(f.values) || f.values.length !== 2 ** width || !f.values.includes('0')) throw new LearningError('Unsupported bias table.');
    previous = scope; return { scope, values: f.values.map(v => uint(v, 128)) };
  });
  const proposal = { chainId: 10143n, pool: deployment.pool, expectedRevision: uint(p.expectedRevision),
    deadline: uint(p.deadline), maxFunding: uint(p.maxFunding, 128), bias };
  const updateData = encodeFunctionData({ abi: poolAbi, functionName: 'updateBias', args: [proposal] });
  const data = approval ? encodeFunctionData({ abi: cashAbi, functionName: 'approve', args: [deployment.pool, proposal.maxFunding] }) : updateData;
  const to = approval ? deployment.cash : deployment.pool;
  if (approval && proposal.maxFunding === 0n || tx.chainId !== 10143 || address(tx.from) !== deployment.updater || address(tx.to) !== to ||
      tx.value !== '0x0' || tx.data?.toLowerCase() !== data.toLowerCase() || review.unsignedUpdateData?.toLowerCase() !== updateData.toLowerCase()) throw new LearningError('Transaction differs from the reviewed proposal.');
  return { approval, proposal, data, to, proposalHash: keccak256(encodeAbiParameters(updateParameters, [proposal])) };
}

async function identity(provider: Provider, owner = true) {
  if (rpcNumber(await request(provider, 'eth_chainId'), 'chain ID') !== 10143n) throw new LearningError('Select public Monad testnet in your wallet.');
  if (owner) {
    const accounts = await request(provider, 'eth_accounts') as string[];
    if (!Array.isArray(accounts) || address(accounts[0]) !== deployment.updater) throw new LearningError(`Select the deployer ${deployment.updater} in your wallet.`);
  }
  const anchor = await request(provider, 'eth_getBlockByNumber', [hex(BigInt(deployment.verified_block)), false]) as { hash?: string } | null;
  if (anchor?.hash?.toLowerCase() !== deployment.verified_block_hash) throw new LearningError('Wallet RPC does not match the verified public testnet deployment.');
}

export async function connectOperator(provider: Provider) {
  await provider.request({ method: 'eth_requestAccounts' });
  if (rpcNumber(await request(provider, 'eth_chainId'), 'chain ID') !== 10143n) await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x279f' }] });
  await identity(provider); return deployment.updater;
}

async function runtime(provider: Provider) {
  for (const key of ['pool', 'pricing_engine', 'base_token_factory'] as const) {
    const code = await request(provider, 'eth_getCode', [deployment[key], 'latest']);
    if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(code)) throw new LearningError('Learning contract unavailable in this wallet network.');
    const bytes = Uint8Array.from(code.slice(2).match(/../g)!, value => parseInt(value, 16));
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
    if (hash !== deployment.runtime_evidence[key].runtime_sha256) throw new LearningError('Wallet contract code differs from the verified deployment.');
  }
}

export async function submitLearning(provider: Provider, review: Review, hooks: {
  authorize(): Promise<void>; current(): boolean; save(value: Pending | null): void;
  now?: () => number;
}) {
  const now = hooks.now || Date.now;
  const plan = validateReview(review, now());
  await hooks.authorize(); await identity(provider); await runtime(provider);
  const snap = await request(provider, 'eth_getBlockByNumber', [hex(uint(review.snapshot.blockNumber)), false]) as { hash?: string } | null;
  const head = await request(provider, 'eth_getBlockByNumber', ['latest', false]) as { timestamp: Hex } | null;
  const age = now() / 1000 - Number(rpcNumber(head?.timestamp, 'latest block timestamp'));
  if (snap?.hash?.toLowerCase() !== review.snapshot.blockHash.toLowerCase() || age < -15 || age > 180) throw new LearningError('Snapshot changed or wallet RPC is stale. Refresh the proposal.');
  const readRevision = async () => {
    const data = encodeFunctionData({ abi: poolAbi, functionName: 'revision' });
    const raw = await request(provider, 'eth_call', [{ to: deployment.pool, data }, 'latest']) as Hex;
    if (decodeFunctionResult({ abi: poolAbi, functionName: 'revision', data: raw }) !== plan.proposal.expectedRevision) throw new LearningError('Pool changed. Prepare a fresh proposal.');
  };
  await readRevision();
  const tx = { chainId: '0x279f', from: deployment.updater, to: plan.to, data: plan.data, value: '0x0' };
  const simulation = await request(provider, 'eth_call', [tx, 'latest']) as Hex;
  const result = decodeFunctionResult({ abi: plan.approval ? cashAbi : poolAbi, functionName: plan.approval ? 'approve' : 'updateBias', data: simulation });
  if (plan.approval ? result !== true : typeof result !== 'bigint' || result > plan.proposal.maxFunding) throw new LearningError('Simulation no longer satisfies the review.');
  const gas = rpcNumber(await request(provider, 'eth_estimateGas', [tx]), 'gas estimate') * 120n / 100n;
  const gasPrice = rpcNumber(await request(provider, 'eth_gasPrice'), 'gas price');
  if (gas <= 0n || gas > 15_000_000n || gasPrice <= 0n || gasPrice > 500_000_000_000n) throw new LearningError('Gas estimate exceeds this testnet signing policy.');
  if (rpcNumber(await request(provider, 'eth_getBalance', [deployment.updater, 'latest']), 'MON balance') < gas * gasPrice) throw new LearningError('Fund the deployer with test MON for network fees.');
  const nonce = hex(rpcNumber(await request(provider, 'eth_getTransactionCount', [deployment.updater, 'pending']), 'pending nonce'));
  await hooks.authorize(); await identity(provider); await readRevision();
  validateReview(review, now());
  if (!hooks.current()) throw new LearningError('Account or review changed. Reconnect and review again.');
  const pending: Pending = { version: 1, review, nonce, hash: null, startedAt: now() };
  hooks.save(pending); // Must persist successfully before opening the signing prompt.
  try {
    const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ ...tx, nonce, gas: hex(gas), gasPrice: hex(gasPrice) }] });
    if (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash)) throw new LearningError('No transaction hash returned.');
    const sent = { ...pending, hash: hash.toLowerCase() }; hooks.save(sent); return sent;
  } catch (error) {
    if ((error as { code?: number })?.code === 4001) { hooks.save(null); throw new LearningError('Wallet request rejected. No transaction was submitted by this request.'); }
    throw new LearningError('Submission outcome is unknown. Check wallet activity and attach its transaction hash. Do not submit again.');
  }
}

export function readPending(storage: Pick<Storage, 'getItem'>): Pending | null {
  const raw = storage.getItem(pendingKey);
  if (!raw) return null;
  if (raw.length > 128_000) throw new LearningError('Saved transaction tracking is invalid.');
  const pending: Pending = JSON.parse(raw);
  if (pending.version !== 1 || !/^0x[0-9a-f]+$/i.test(pending.nonce) ||
      pending.hash !== null && !/^0x[0-9a-f]{64}$/i.test(pending.hash)) throw new LearningError('Saved transaction tracking is invalid.');
  validateReview(pending.review, Date.now(), true); return pending;
}

type RpcTx = { hash: string; from: string; to: string; input: string; value: Hex; nonce: Hex; chainId?: Hex; blockHash: string; blockNumber: Hex };
type RpcLog = { address: string; topics: [Hex, ...Hex[]]; data: Hex; removed?: boolean };
type RpcReceipt = { transactionHash: string; from: string; to: string; blockHash: string; blockNumber: Hex; status: Hex; logs: RpcLog[] };
export function matchReceipt(pending: Pending, tx: RpcTx, receipt: RpcReceipt, canonical: { hash: string }, head: Hex) {
  const plan = validateReview(pending.review, Date.now(), true);
  if (!pending.hash || tx.hash.toLowerCase() !== pending.hash || receipt.transactionHash.toLowerCase() !== pending.hash ||
      address(tx.from) !== deployment.updater || address(receipt.from) !== deployment.updater || address(tx.to) !== plan.to || address(receipt.to) !== plan.to ||
      tx.input.toLowerCase() !== plan.data.toLowerCase() || rpcNumber(tx.value, 'transaction value') !== 0n || rpcNumber(tx.nonce, 'transaction nonce') !== rpcNumber(pending.nonce, 'saved nonce') ||
      tx.chainId && rpcNumber(tx.chainId, 'transaction chain ID') !== 10143n || tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber ||
      canonical.hash !== receipt.blockHash) throw new LearningError('Transaction or canonical receipt does not match the saved review.');
  if (rpcNumber(head, 'latest block number') < rpcNumber(receipt.blockNumber, 'receipt block number') + 1n) return 'confirming';
  if (receipt.status === '0x0') return 'reverted';
  if (receipt.status !== '0x1') throw new LearningError('Unexpected receipt status.');
  const topic = toEventSelector(plan.approval ? 'Approval(address,address,uint256)' : 'BiasUpdated(uint256,bytes32,uint128,uint128)');
  const logs = receipt.logs.filter(log => address(log.address) === plan.to && log.topics[0]?.toLowerCase() === topic);
  if (logs.length !== 1 || logs[0].removed) throw new LearningError('Expected confirmation event is missing.');
  const decoded = decodeEventLog({ abi: plan.approval ? cashAbi : poolAbi, ...logs[0], strict: true }).args as unknown as Record<string, unknown>;
  if (plan.approval ? address(decoded.owner as string) !== deployment.updater || address(decoded.spender as string) !== deployment.pool || decoded.value !== plan.proposal.maxFunding :
    decoded.revision !== plan.proposal.expectedRevision + 1n || decoded.proposalHash !== plan.proposalHash ||
    typeof decoded.fundingAdded !== 'bigint' || decoded.fundingAdded > plan.proposal.maxFunding || decoded.reserve !== uint(pending.review.reserveAfterAtoms, 128)) throw new LearningError('Confirmation event differs from the reviewed update.');
  return 'confirmed';
}

export async function checkLearningReceipt(provider: Provider, pending: Pending) {
  if (!pending.hash) throw new LearningError('Attach the transaction hash from wallet activity first.');
  await identity(provider, false);
  const tx = await request(provider, 'eth_getTransactionByHash', [pending.hash]) as RpcTx | null;
  const receipt = await request(provider, 'eth_getTransactionReceipt', [pending.hash]) as RpcReceipt | null;
  if (!tx || !receipt) return 'pending';
  const canonical = await request(provider, 'eth_getBlockByNumber', [receipt.blockNumber, false]) as { hash: string };
  const head = await request(provider, 'eth_blockNumber') as Hex;
  const result = matchReceipt(pending, tx, receipt, canonical, head);
  const again = await request(provider, 'eth_getBlockByNumber', [receipt.blockNumber, false]) as { hash: string };
  if (again?.hash !== canonical?.hash) throw new LearningError('Receipt block changed. Check again after the reorg.');
  return result;
}
