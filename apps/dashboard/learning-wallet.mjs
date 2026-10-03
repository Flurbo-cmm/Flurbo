// Every approval and funded operation requires a separate explicit wallet action.
const CHAIN = 31339n;
const selectors = { approve: '095ea7b3', buy: '3e6b6cde', sell: 'c39849c5', learn: '69e555e4' };
const addr = v => {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(v) || BigInt(v) === 0n) throw Error('Invalid address');
  return v.toLowerCase();
};
const uint = (v, bits = 256n) => {
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v) || v.length > 78) throw Error('Invalid amount');
  const n = BigInt(v); if (n >= 1n << bits) throw Error('Amount overflow'); return n;
};
const word = v => BigInt(v).toString(16).padStart(64, '0');
const staticCall = (selector, ...values) => '0x' + selector + values.map(word).join('');

export function encodeUpdate(p) {
  if (uint(p.chainId) !== CHAIN || !Array.isArray(p.bias) || p.bias.length > 64) throw Error('Wrong learning domain');
  addr(p.pool); uint(p.expectedRevision); uint(p.deadline); uint(p.maxFunding, 128n);
  let scopeBefore = 0n;
  const items = p.bias.map(f => {
    const scope = uint(f.scope, 32n);
    if (scope <= scopeBefore || scope > 3n || !Array.isArray(f.values) || f.values.length !== (scope === 3n ? 4 : 2)) throw Error('Unsupported bias');
    scopeBefore = scope;
    f.values.forEach(v => uint(v, 128n));
    if (!f.values.includes('0')) throw Error('Bias is not normalized');
    return word(scope) + word(64) + word(f.values.length) + f.values.map(word).join('');
  });
  let offset = items.length * 32;
  const offsets = items.map(item => { const here = word(offset); offset += item.length / 2; return here; }).join('');
  const tuple = [p.chainId, p.pool, p.expectedRevision, p.deadline, p.maxFunding, 192].map(word).join('')
    + word(items.length) + offsets + items.join('');
  return '0x' + selectors.learn + word(32) + tuple;
}

export function validatePlan(plan, now = Date.now() / 1000) {
  if (!['buy', 'sell', 'learn'].includes(plan.kind) || !['approve', plan.kind].includes(plan.action)
    || plan.chainId !== Number(CHAIN) || plan.value !== '0x0') throw Error('Unsupported review');
  [plan.owner, plan.pool, plan.token, plan.to].forEach(addr);
  const s = plan.snapshot;
  if (s.chainId !== String(CHAIN) || addr(s.pool) !== addr(plan.pool) || !/^0x[0-9a-fA-F]{64}$/.test(s.blockHash)) throw Error('Wrong snapshot');
  const stamp = Number(uint(s.timestamp));
  if (now - stamp > 45 || stamp - now > 10 || uint(plan.deadline) <= BigInt(Math.floor(now))) throw Error('Review expired. Refresh it.');
  uint(s.revision); uint(s.blockNumber);
  const limit = uint(plan.limitAtoms, 128n);
  if (plan.quantityAtoms !== '1000000' || limit > (plan.kind === 'learn' ? 5000000n : 1000000n)) throw Error('Review limit exceeded');
  if (plan.action === 'approve' && (plan.kind === 'sell' || limit === 0n)) throw Error('Unneeded approval');
  let data;
  if (plan.action === 'approve') data = staticCall(selectors.approve, plan.pool, limit);
  else if (plan.kind === 'learn') {
    const p = plan.proposal;
    if (p.pool !== plan.pool || p.expectedRevision !== s.revision || p.deadline !== plan.deadline || p.maxFunding !== plan.limitAtoms) throw Error('Proposal differs from review');
    data = encodeUpdate(p);
  } else data = staticCall(selectors[plan.kind], 3, 8, 1000000, limit, plan.deadline);
  if (addr(plan.to) !== addr(plan.action === 'approve' ? plan.token : plan.pool) || plan.data.toLowerCase() !== data.toLowerCase()) throw Error('Calldata differs from review');
  return data;
}

export async function context(provider, state, owner) {
  const accounts = await provider.request({ method: 'eth_accounts' });
  if (!accounts.length || addr(accounts[0]) !== addr(owner)) throw Error('Select the reviewed test account');
  if (BigInt(await provider.request({ method: 'eth_chainId' })) !== CHAIN) throw Error('Select Flurbo learning lab in MetaMask');
  const block = await provider.request({ method: 'eth_getBlockByNumber', params: [state.checkpoint.number, false] });
  if (block?.hash !== state.checkpoint.hash) throw Error('Wallet RPC does not match this learning lab');
}

export async function submit(provider, plan, state) {
  const data = validatePlan(plan);
  if (state.owner !== plan.owner || state.pool !== plan.pool || state.token !== plan.token) throw Error('Lab changed; review again');
  await context(provider, state, plan.owner);
  const block = await provider.request({ method: 'eth_getBlockByNumber', params: ['0x' + BigInt(plan.snapshot.blockNumber).toString(16), false] });
  if (block?.hash !== plan.snapshot.blockHash) throw Error('Snapshot changed; review again');
  const read = async selector => provider.request({ method: 'eth_call', params: [{ to: plan.pool, data: selector }, 'latest'] });
  if (BigInt(await read('0x7cc96380')) !== BigInt(plan.snapshot.revision)) throw Error('Pool changed; review again');
  if (BigInt(await read('0xdf034cd0')) !== BigInt(plan.owner) || BigInt(await read('0xd8dfeb45')) !== BigInt(plan.token)) throw Error('Unexpected pool authority or collateral');
  const tx = { from: plan.owner, to: plan.to, data, value: '0x0' };
  await provider.request({ method: 'eth_call', params: [tx, 'latest'] });
  validatePlan(plan); // Wallet/RPC work may have taken the review past expiry.
  return provider.request({ method: 'eth_sendTransaction', params: [tx] });
}

export function receiptMatches(plan, tx, receipt, canonical, head) {
  if (!tx || !receipt || receipt.status !== '0x1' || tx.hash !== receipt.transactionHash
    || tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber
    || addr(tx.from) !== addr(plan.owner) || addr(tx.to) !== addr(plan.to)
    || tx.input.toLowerCase() !== plan.data.toLowerCase() || BigInt(tx.value) !== 0n
    || canonical?.hash !== receipt.blockHash || BigInt(head) < BigInt(receipt.blockNumber) + 1n) return false;
  const topics = { approve: '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
    learn: '0x293396ece8beae6ff9a480d88a647e0b744bdd55a95b3e33567484b49d04fba1',
    buy: '0xfafd4a382ead0cb54fe827af5995137a1a8b433ebfd5a8d13def35a83adfb9b5',
    sell: '0xfafd4a382ead0cb54fe827af5995137a1a8b433ebfd5a8d13def35a83adfb9b5' };
  const logs = receipt.logs.filter(log => addr(log.address) === addr(plan.to) && log.topics[0] === topics[plan.action]);
  if (logs.length !== 1) return false;
  const log = logs[0], words = log.data.slice(2).match(/.{64}/g)?.map(v => BigInt('0x' + v)) || [];
  if (plan.action === 'approve') return log.topics.length === 3 && BigInt(log.topics[1]) === BigInt(plan.owner)
    && BigInt(log.topics[2]) === BigInt(plan.pool) && words.length === 1 && words[0] === BigInt(plan.limitAtoms);
  if (plan.action === 'learn') return log.topics.length === 3 && BigInt(log.topics[1]) === BigInt(plan.snapshot.revision) + 1n
    && words.length === 2 && words[0] === BigInt(plan.details.fundingAtoms) && words[1] === BigInt(plan.details.reserveAfterAtoms);
  return log.topics.length === 4 && BigInt(log.topics[1]) === BigInt(plan.owner) && BigInt(log.topics[2]) === 3n
    && BigInt(log.topics[3]) === 8n && words.length === 3 && words[0] === (plan.action === 'buy' ? 1n : 0n)
    && words[1] === 1000000n && (plan.action === 'buy' ? words[2] <= BigInt(plan.limitAtoms) : words[2] >= BigInt(plan.limitAtoms));
}
