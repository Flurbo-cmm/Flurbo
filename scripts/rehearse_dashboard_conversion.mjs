// Explicit local integration test. All writes target a disposable clone, never the persistent demo.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { prepare, prepareConversion, makeConversionPlan, sendReviewed, reconcile, encode } from '../apps/dashboard/wallet.mjs';

if (process.env.FLURBO_LOCAL_CONVERSION_REHEARSAL !== '1') throw new Error('Explicit disposable-clone opt-in required.');
const url = 'http://127.0.0.1:18546', python = process.env.FLURBO_PYTHON || 'python';
const m = JSON.parse(readFileSync('target/deployments/demo-verified.json', 'utf8'));
let id = 0;
async function rpc(method, params = []) {
  const callId = ++id;
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: callId, method, params }) });
  const data = await response.json();
  if (data.error || data.id !== callId) throw new Error(`Local rehearsal RPC failed: ${method}`);
  return data.result;
}
assert.equal(m.environment, 'local_fork');
assert.match(await rpc('web3_clientVersion'), /anvil/i);
assert.equal(BigInt(await rpc('eth_chainId')), 10143n);
assert.equal((await rpc('eth_getBlockByNumber', ['0x' + m.verified_block.toString(16), false])).hash, m.verified_block_hash);
// Source access is read-only HTTP snapshots; no transaction transport points to the source.
async function sourceState() {
  const state = await (await fetch('http://127.0.0.1:18765/api/state')).json();
  assert.equal(state.environment, 'local_fork'); assert.equal(state.pool.phase, 'open');
  assert.equal(state.snapshot.stale, false);
  return state.pool;
}
const sourceBefore = await sourceState();
const accounts = await rpc('eth_accounts'), owner = accounts[7].toLowerCase();
assert.notEqual(owner, m.operator);
const provider = { request: ({ method, params }) => method === 'eth_accounts' ? Promise.resolve([owner]) : rpc(method, params) };
const bridge = `import json,sys
sys.path.insert(0,'scripts')
from dashboard_data import Dashboard,DashboardRpc
from check_monad_readiness import CONFIG
p=json.load(sys.stdin)
d=Dashboard(json.load(open('target/deployments/demo-verified.json')),json.loads(CONFIG.read_text())['networks']['testnet'],DashboardRpc('http://127.0.0.1:18546'),'local_fork')
print(json.dumps(d.snapshot(p['owner'],[(128,2)]) if p['kind']=='state' else d.quote(p.get('side','buy'),128,2,p.get('quantity',1000000)) if p['kind']=='quote' else d.transaction(p['hash'])))
`;
function read(kind, options = {}) {
  const result = spawnSync(python, ['-c', bridge], { input: JSON.stringify({ kind, owner, ...options }), encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('Dashboard bridge failed: ' + result.stderr);
  return JSON.parse(result.stdout);
}
async function fresh() {
  const timestamp = Number(BigInt((await rpc('eth_getBlockByNumber', ['latest', false])).timestamp));
  const ahead = timestamp * 1000 - Date.now();
  assert.ok(ahead < 10000, 'Use a fresh clone; do not reuse a time-warped settlement clone');
  if (ahead > 0) await new Promise(resolve => setTimeout(resolve, ahead + 50));
  const now = Math.floor(Date.now() / 1000);
  if (now > timestamp) { await rpc('evm_setNextBlockTimestamp', [now]); await rpc('evm_mine'); }
}
await fresh();
assert.equal(read('state').wallet.positions[0].quantity_atoms, '0');
assert.equal(read('state').wallet.receipt_atoms, '0');
const funding = await rpc('eth_sendTransaction', [{ from: accounts[0], to: m.cash, data: encode('a9059cbb', owner, 20000000), value: '0x0' }]);
await rpc('evm_mine'); await fresh();
assert.equal((await rpc('eth_getTransactionReceipt', [funding])).status, '0x1');
let bought = false;
for (let i = 0; i < 4 && !bought; i++) {
  await fresh();
  const plan = await prepare(provider, read('state'), read('quote', { quantity: 2000000 }), owner, 50);
  const hash = await sendReviewed(provider, plan, read('state'));
  await rpc('evm_mine'); await fresh();
  assert.equal(reconcile(plan, read('transaction', { hash }).transaction), 'matched');
  bought = plan.kind === 'buy';
}
assert.equal(bought, true);
const initial = read('state');
const report = { environment: 'disposable_local_clone', owner, conversions: [] };
for (const [kind, quantity] of [['wrap', '1000000'], ['unwrap', '400000'], ['unwrap', '600000']]) {
  await fresh();
  const before = read('state'), quoteBefore = read('quote').quote.collateral_atoms;
  const plan = await prepareConversion(provider, before, kind, owner, quantity);
  const hash = await sendReviewed(provider, plan, read('state'));
  await rpc('evm_mine'); await fresh();
  const tx = read('transaction', { hash }).transaction, after = read('state');
  assert.equal(reconcile(plan, tx), 'matched'); assert.ok(tx.confirmations >= 2);
  const delta = BigInt(quantity) * (kind === 'wrap' ? 1n : -1n);
  assert.equal(BigInt(after.wallet.receipt_atoms) - BigInt(before.wallet.receipt_atoms), delta);
  assert.equal(BigInt(after.wallet.positions[0].quantity_atoms) - BigInt(before.wallet.positions[0].quantity_atoms), -delta);
  assert.equal(BigInt(after.pool.receipt_supply_atoms) - BigInt(before.pool.receipt_supply_atoms), delta);
  assert.equal(BigInt(after.pool.receipt_escrow_atoms) - BigInt(before.pool.receipt_escrow_atoms), delta);
  assert.equal(after.wallet.ausd_atoms, before.wallet.ausd_atoms);
  assert.equal(after.pool.pool_collateral_atoms, before.pool.pool_collateral_atoms);
  assert.equal(after.pool.required_collateral_atoms, before.pool.required_collateral_atoms);
  assert.equal(after.pool.receipt_backed, true); assert.equal(after.pool.covered, true);
  assert.equal(read('quote').quote.collateral_atoms, quoteBefore);
  report.conversions.push({ kind, quantity, hash, matched: true, confirmations: tx.confirmations });
}
const final = read('state');
assert.equal(final.wallet.receipt_atoms, '0');
assert.equal(final.wallet.positions[0].quantity_atoms, initial.wallet.positions[0].quantity_atoms);
assert.throws(() => makeConversionPlan(final, 'unwrap', owner, '1'));
assert.deepEqual(await sourceState(), sourceBefore, 'Persistent demo pool must stay unchanged');
report.sourceUnchanged = true;
report.invariants = 'exact holdings/supply/escrow deltas; unchanged AUSD, collateral, liability and quote';
writeFileSync('target/deployments/dashboard-conversion-rehearsal.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
