// Opt-in integration rehearsal against a disposable clone on 18546, never the user's wallet.
// Start that clone as documented in DASHBOARD_TRADING.md. The HTTP server has no signing path.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { prepare, sendReviewed, reconcile, encode } from '../apps/dashboard/wallet.mjs';

if (process.env.FLURBO_LOCAL_WALLET_REHEARSAL !== '1') throw new Error('Set FLURBO_LOCAL_WALLET_REHEARSAL=1 for the disposable local clone only.');
const url = 'http://127.0.0.1:18546';
const python = process.env.FLURBO_PYTHON || 'python';
let counter = 0;
async function rpc(method, params = []) {
  const id = ++counter;
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  const data = await response.json();
  if (data.error || data.id !== id) throw new Error(`Local rehearsal RPC failed: ${method}`);
  return data.result;
}
assert.match(await rpc('web3_clientVersion'), /anvil/i);
assert.equal(BigInt(await rpc('eth_chainId')), 10143n);
const manifest = JSON.parse(readFileSync('target/deployments/demo-verified.json', 'utf8'));
assert.equal(manifest.environment, 'local_fork');
assert.equal((await rpc('eth_getBlockByNumber', ['0x' + manifest.verified_block.toString(16), false])).hash, manifest.verified_block_hash);
const accounts = await rpc('eth_accounts');
const owner = accounts[1].toLowerCase();
assert.notEqual(owner, manifest.operator);
// A disposable transport adapter exercises exactly the same wallet module against real EVM calls.
const provider = { request: ({ method, params }) => method === 'eth_accounts' ? Promise.resolve([owner]) : rpc(method, params) };
const bridge = `import json,sys
sys.path.insert(0,'scripts')
from dashboard_data import Dashboard,DashboardRpc
from check_monad_readiness import CONFIG
m=json.load(open('target/deployments/demo-verified.json'))
d=Dashboard(m,json.loads(CONFIG.read_text())['networks']['testnet'],DashboardRpc('http://127.0.0.1:18546'),'local_fork')
p=json.load(sys.stdin)
print(json.dumps(d.snapshot(p['owner'],[(p['scope'],p['mask'])]) if p['kind']=='state' else d.quote(p['side'],p['scope'],p['mask'],1000000) if p['kind']=='quote' else d.transaction(p['hash'])))
`;
function read(kind, options) {
  const result = spawnSync(python, ['-c', bridge], { input: JSON.stringify({ kind, ...options }), encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('Dashboard model bridge failed: ' + result.stderr);
  return JSON.parse(result.stdout);
}
async function fresh() {
  const block = await rpc('eth_getBlockByNumber', ['latest', false]);
  const timestamp = Number(BigInt(block.timestamp));
  if (timestamp > Date.now() / 1000) await new Promise(resolve => setTimeout(resolve, timestamp * 1000 - Date.now() + 50));
  const now = Math.floor(Date.now() / 1000);
  if (now > timestamp) { await rpc('evm_setNextBlockTimestamp', [now]); await rpc('evm_mine'); }
}
const funding = await rpc('eth_sendTransaction', [{ from: accounts[0], to: manifest.cash, data: encode('a9059cbb', owner, 10000000), value: '0x0' }]);
assert.equal((await rpc('eth_getTransactionReceipt', [funding])).status, '0x1');
const report = { environment: 'disposable_local_clone', account: owner, funding, actions: [] };
for (const [scope, mask] of [[3, 8], [128, 2]]) {
  for (const side of ['buy', 'sell']) {
    let traded = false;
    for (let step = 0; step < 4 && !traded; step++) {
      await fresh();
      const options = { owner, scope, mask, side };
      const before = read('state', options), quoted = read('quote', options);
      const plan = await prepare(provider, before, quoted, owner, 50);
      const hash = await sendReviewed(provider, plan, read('state', options));
      await fresh();
      const tx = read('transaction', { hash }).transaction;
      assert.equal(reconcile(plan, tx), 'matched');
      const after = read('state', options);
      assert.equal(after.pool.covered, true); assert.equal(after.pool.receipt_backed, true);
      if (plan.kind === 'approve') assert.equal(after.wallet.pool_allowance_atoms, plan.approval);
      else {
        const event = tx.events.find(e => e.kind === 'trade');
        const direction = side === 'buy' ? 1n : -1n;
        assert.equal(BigInt(after.wallet.positions[0].quantity_atoms) - BigInt(before.wallet.positions[0].quantity_atoms), direction * 1000000n);
        assert.equal(BigInt(after.wallet.ausd_atoms) - BigInt(before.wallet.ausd_atoms), -direction * BigInt(event.collateral_atoms));
        traded = true;
      }
      report.actions.push({ kind: plan.kind, scope, mask, approval: plan.approval, hash, status: tx.status, events: tx.events });
    }
    assert.equal(traded, true, 'Approval steps must terminate in the requested trade');
  }
}
writeFileSync('target/deployments/dashboard-wallet-rehearsal.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ environment: report.environment, actions: report.actions.map(a => a.kind), matched: report.actions.length, walletDeltas: 'exact', covered: true }));
