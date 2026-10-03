// Real EVM lifecycle on a disposable clone; never sends to the persistent demo or a user wallet.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { prepare, prepareRedemption, makeRedemptionPlan, sendReviewed, reconcile, encode } from '../apps/dashboard/wallet.mjs';

if (process.env.FLURBO_LOCAL_REDEMPTION_REHEARSAL !== '1') throw new Error('Explicit disposable-clone opt-in required.');
const url = 'http://127.0.0.1:18546', source = 'http://127.0.0.1:18545';
const python = process.env.FLURBO_PYTHON || 'python';
const manifest = JSON.parse(readFileSync('target/deployments/demo-verified.json', 'utf8'));
let id = 0, testTime;
async function readRpc(endpoint, method, params = []) {
  const callId = ++id;
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: callId, method, params }) });
  const data = await response.json();
  if (data.error || data.id !== callId) throw new Error(`Local rehearsal RPC failed: ${method}`);
  return data.result;
}
const rpc = (method, params = []) => readRpc(url, method, params);
assert.equal(manifest.environment, 'local_fork');
assert.match(await rpc('web3_clientVersion'), /anvil/i);
assert.equal(BigInt(await rpc('eth_chainId')), 10143n);
assert.equal((await rpc('eth_getBlockByNumber', ['0x' + manifest.verified_block.toString(16), false])).hash, manifest.verified_block_hash);
// Only read-only selectors may reach the persistent source.
async function sourceState() {
  const values = {};
  for (const selector of ['3f6fa655', 'b53105a3']) values[selector] = await readRpc(source, 'eth_call', [{ to: manifest.pool, data: '0x' + selector }, 'latest']);
  values.cash = await readRpc(source, 'eth_call', [{ to: manifest.cash, data: encode('70a08231', manifest.pool) }, 'latest']);
  return values;
}
const sourceBefore = await sourceState();
assert.equal(BigInt(sourceBefore['3f6fa655']), 0n);
const accounts = await rpc('eth_accounts'), owner = accounts[8].toLowerCase();
assert.notEqual(owner, manifest.operator);
const provider = { request: ({ method, params }) => method === 'eth_accounts' ? Promise.resolve([owner]) : rpc(method, params) };
const bridge = `import json,sys
sys.path.insert(0,'scripts')
from dashboard_data import Dashboard,DashboardRpc
from check_monad_readiness import CONFIG
p=json.load(sys.stdin)
m=json.load(open('target/deployments/demo-verified.json'))
d=Dashboard(m,json.loads(CONFIG.read_text())['networks']['testnet'],DashboardRpc('http://127.0.0.1:18546'),'local_fork',clock=lambda:p['now'])
print(json.dumps(d.snapshot(p['owner'],[(p['scope'],p['mask'])]) if p['kind']=='state' else d.quote('buy',p['scope'],p['mask'],2000000) if p['kind']=='quote' else d.transaction(p['hash'])))
`;
function read(kind, options = {}) {
  const result = spawnSync(python, ['-c', bridge], { input: JSON.stringify({ kind, now: testTime, owner, ...options }), encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('Dashboard bridge failed: ' + result.stderr);
  return JSON.parse(result.stdout);
}
async function syncTime() { testTime = Number(BigInt((await rpc('eth_getBlockByNumber', ['latest', false])).timestamp)); }
async function sent(tx) {
  const hash = await rpc('eth_sendTransaction', [{ ...tx, gas: tx.gas || '0x1c9c380' }]);
  await rpc('evm_mine');
  assert.equal((await rpc('eth_getTransactionReceipt', [hash])).status, '0x1');
  await syncTime();
  return hash;
}
const realNow = Date.now;
const report = { environment: 'disposable_local_clone', rpc: url, clock: 'test-only chain time; production freshness guards unchanged', owner, acquisitions: [], redemptions: [] };
try {
  await syncTime(); Date.now = () => testTime * 1000;
  await sent({ from: accounts[0], to: manifest.cash, data: encode('a9059cbb', owner, 20000000), value: '0x0' });
  const claims = [{ scope: 3, mask: 8 }, { scope: 129, mask: 1 }];
  for (const selected of claims) {
    assert.equal(read('state', selected).wallet.positions[0].quantity_atoms, '0');
    let bought = false;
    for (let step = 0; step < 4 && !bought; step++) {
      const before = read('state', selected);
      const plan = await prepare(provider, before, read('quote', selected), owner, 50);
      const hash = await sendReviewed(provider, plan, before);
      await rpc('evm_mine'); await syncTime();
      const tx = read('transaction', { hash }).transaction;
      assert.equal(reconcile(plan, tx), 'matched');
      report.acquisitions.push({ kind: plan.kind, hash, ...selected });
      bought = plan.kind === 'buy';
    }
    assert.equal(bought, true);
    assert.throws(() => makeRedemptionPlan(read('state', selected), selected, owner, '1000000'));
  }
  await rpc('evm_setNextBlockTimestamp', [manifest.closes_at + 1]); await rpc('evm_mine'); await syncTime();
  const closed = read('state', claims[0]);
  assert.equal(closed.pool.phase, 'closed'); assert.equal(closed.redemption_available, false);
  assert.equal(closed.wallet.positions[0].redeemable_atoms, null);
  assert.throws(() => makeRedemptionPlan(closed, claims[0], owner, '1000000'));
  report.resolution = await sent({ from: manifest.resolver, to: manifest.pool, data: encode('33c547d6', 3), value: '0x0' });
  for (const [selected, quantity, expected] of [[claims[0], '500000', '500000'], [claims[0], '1500000', '1500000'], [claims[1], '2000000', '0']]) {
    const before = read('state', selected);
    assert.equal(before.redemption_available, true);
    assert.equal(before.wallet.positions[0].settlement, expected === '0' ? 'losing' : 'winning');
    const plan = await prepareRedemption(provider, before, selected, owner, quantity);
    assert.equal(plan.payout, expected);
    const hash = await sendReviewed(provider, plan, before);
    await rpc('evm_mine'); await syncTime();
    const tx = read('transaction', { hash }).transaction, after = read('state', selected);
    assert.equal(reconcile(plan, tx), 'matched'); assert.ok(tx.confirmations >= 2);
    assert.equal(BigInt(after.wallet.ausd_atoms) - BigInt(before.wallet.ausd_atoms), BigInt(expected));
    assert.equal(BigInt(before.wallet.positions[0].quantity_atoms) - BigInt(after.wallet.positions[0].quantity_atoms), BigInt(quantity));
    assert.equal(BigInt(before.pool.required_collateral_atoms) - BigInt(after.pool.required_collateral_atoms), BigInt(expected));
    assert.equal(after.pool.covered, true); assert.equal(after.pool.receipt_backed, true);
    report.redemptions.push({ ...selected, quantity, payout: expected, hash, confirmations: tx.confirmations, matched: true });
  }
  for (const selected of claims) {
    const state = read('state', selected);
    assert.equal(state.wallet.positions[0].quantity_atoms, '0');
    assert.throws(() => makeRedemptionPlan(state, selected, owner, '1'));
  }
  assert.deepEqual(await sourceState(), sourceBefore, 'Persistent source pool must remain unchanged');
  report.sourceUnchanged = true;
  writeFileSync('target/deployments/dashboard-redemption-rehearsal.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { Date.now = realNow; }
