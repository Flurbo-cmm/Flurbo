// Run only through rehearse_learning_lab.py on its fresh, owned mock chain.
import assert from 'node:assert/strict';
import { context, encodeUpdate, receiptMatches, submit, validatePlan } from './learning-wallet.mjs';
if (!process.argv.includes('--execute-local')) throw Error('Explicit local execution flag required');
const url = 'http://127.0.0.1:18766';
const rpc = async (method, params = []) => {
  const result = await (await fetch('http://127.0.0.1:18548', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (result.error) throw Error(JSON.stringify(result.error)); return result.result;
};
assert.equal(await rpc('eth_chainId'), '0x7a6b');
assert.match(await rpc('web3_clientVersion'), /anvil/i);
const owner = (await rpc('eth_accounts'))[1];
const provider = { request: ({ method, params }) => method === 'eth_accounts' ? Promise.resolve([owner]) : rpc(method, params) };
const api = async (path, data) => {
  const response = await fetch(url + path, data ? { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url }, body: JSON.stringify(data) } : {});
  const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value;
};
const badOrigin = await fetch(url + '/api/setup', { method: 'POST', headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({wallet: owner}) });
assert.equal(badOrigin.status, 403);
let state = await api('/api/setup', { wallet: owner });
assert.equal(state.balanceAtoms, '100000000');
const transactions = [];
async function execute(kind) {
  let plan = await api('/api/prepare?kind=' + kind);
  validatePlan(plan);
  assert.throws(() => validatePlan({...plan, data: plan.data + '00'}), /Calldata/);
  assert.throws(() => validatePlan(plan, Number(plan.snapshot.timestamp) + 46), /expired/);
  assert.throws(() => validatePlan({...plan, limitAtoms: '5000001'}), /limit/);
  await assert.rejects(context({request: async ({method}) => method === 'eth_accounts' ? [owner] : method === 'eth_chainId' ? '0x7a6b' : {hash: '0x00'}}, state, owner), /RPC/);
  if (plan.action === 'learn') assert.equal(encodeUpdate(plan.proposal), plan.data);
  const hash = await submit(provider, plan, state);
  await rpc('evm_mine'); await rpc('evm_mine');
  const receipt = await rpc('eth_getTransactionReceipt', [hash]);
  const tx = await rpc('eth_getTransactionByHash', [hash]);
  const block = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
  const head = await rpc('eth_blockNumber');
  assert.equal(receiptMatches(plan, tx, receipt, block, head), true, JSON.stringify({plan, receipt}));
  assert.equal(receiptMatches(plan, tx, {...receipt, status:'0x0'}, block, head), false);
  assert.equal(receiptMatches(plan, tx, receipt, {hash: '0x00'}, head), false);
  assert.equal(receiptMatches(plan, tx, receipt, block, receipt.blockNumber), false);
  assert.equal(receiptMatches(plan, {...tx, input:'0x'}, receipt, block, head), false);
  state = await api('/api/state');
  transactions.push({action: plan.action, hash, details: plan.details});
  return plan;
}
if ((await execute('buy')).action === 'approve') await execute('buy');
assert.equal(state.holdingsAtoms, '1000000');
const holdings = state.holdingsAtoms, payout = state.payoutAtoms;
const before = state.poolBalanceAtoms;
if ((await execute('learn')).action === 'approve') await execute('learn');
assert.equal(state.holdingsAtoms, holdings);
assert.equal(state.payoutAtoms, payout);
assert.ok(BigInt(state.poolBalanceAtoms) > BigInt(before));
assert.ok(BigInt(state.poolBalanceAtoms) >= BigInt(state.reserveAtoms));
await execute('sell');
assert.equal(state.holdingsAtoms, '0');
assert.ok(BigInt(state.poolBalanceAtoms) >= BigInt(state.reserveAtoms));
console.log(JSON.stringify({status: 'passed', transactions, final: state}, null, 2));
