// Exercise the controller's asynchronous wallet lifecycle; these are not extension UI tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mountTrading } from './trading-ui.mjs';

const account = '0x' + '11'.repeat(20), pool = '0x' + '22'.repeat(20), cash = '0x' + '33'.repeat(20);
const hash = '0x' + 'aa'.repeat(32), txHash = '0x' + 'bb'.repeat(32), key = 'flurbo.local.pending.v1';
async function harness(run, saved, options = {}) {
  const previous = Object.fromEntries(['window', 'document', 'sessionStorage', 'setInterval'].map(k => [k, globalThis[k]]));
  const nodes = new Map(), storage = new Map(saved ? [[key, JSON.stringify(saved)]] : []), intervals = [];
  function node() { return { textContent: '', value: '', hidden: false, disabled: false, children: [], handlers: {},
    addEventListener(type, fn) { this.handlers[type] = fn; }, append(child) { this.children.push(child); }, replaceChildren(...children) { this.children = children; } }; }
  const get = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  class Provider extends EventEmitter {
    isMetaMask = true;
    calls = []; resolve; reject;
    async request({ method, params }) {
      this.calls.push({ method, params });
      if (method === 'eth_sendTransaction') return new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
      if (method === 'eth_call' && ['0xb0a52172', '0xf6c4eade'].includes(params[0].data.slice(0, 10))) return '0x';
      return { eth_requestAccounts: [account], eth_accounts: [account], eth_chainId: '0x279f', eth_getBlockByNumber: { hash },
        eth_call: '0x' + BigInt(params?.[0]?.data?.startsWith('0xdf992423') ? this.redemptionPayout : ['0x095ea7b3','0xa9059cbb'].includes(params?.[0]?.data?.slice(0,10)) ? 1 : 250001).toString(16).padStart(64, '0'), eth_estimateGas: '0x186a0', eth_gasPrice: '0x3b9aca00' }[method];
    }
  }
  const provider = new Provider();
  const now = Math.floor(Date.now() / 1000);
  const snapshot = { environment: 'local_fork', chain_id: 10143, trading_available: true, snapshot: { timestamp: now, stale: false, block_number: 100, block_hash: hash },
    contracts: { pool, cash }, pool: { phase: 'open', resolved: false }, cluster: { closes_at: now + 1000, events: [{ index: 0 }, { index: 1 }] }, wallet: { address: account, ausd_atoms: '10000000', native_balance_wei: '1000000000000000000', pool_allowance_atoms: '1000000', positions: [] } };
  const quote = { environment: 'local_fork', chain_id: 10143, snapshot: snapshot.snapshot, quote: { side: 'buy', scope: 3, mask: 8, quantity_atoms: '1000000', collateral_atoms: '250001', valid_until: now + 300 } };
  const state = { tx: { status: 'unknown', confirmations: 0 }, refreshes: 0 };
  try {
    globalThis.document = { getElementById: get, createElement: node };
    globalThis.window = Object.assign(new EventTarget(), { ethereum: provider, confirm: () => true });
    globalThis.sessionStorage = { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) };
    globalThis.setInterval = fn => { intervals.push(fn); return 1; };
    get('slippage').value = '50'; get('conversion-quantity').value = '1';
    const controller = mountTrading({ getState: () => snapshot, getSelection: () => ({ scope: 3, mask: 8, quantity: '1000000', label: 'A YES AND B YES' }), getQuote: () => quote, readSnapshot: async () => snapshot, accountChanged() {},
      readTransaction: async () => ({ transaction: state.tx }), invalidateQuote() {}, refresh() { state.refreshes++; }, ...options });
    const click = id => get(id).handlers.click();
    await run({ get, storage, provider, click, state, controller, snapshot });
  } finally { for (const [k, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[k]; else globalThis[k] = value; } }
}
async function submitting(f) {
  await f.click('connect-wallet'); await f.click('review-trade');
  const task = f.click('confirm-trade');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof f.provider.resolve, 'function');
  return { task };
}
test('learning tracking is isolated and market switching locks through review and submission', async () => {
  const busy = [], learningKey = 'flurbo.learning.trading.pending.v1';
  await harness(async f => {
    assert.equal(f.get('review-trade').disabled, true); // No wallet connected yet, not an original pending lock.
    await f.click('connect-wallet'); await f.click('review-trade');
    assert.equal(busy.at(-1), true);
    await f.click('cancel-review'); assert.equal(busy.at(-1), false);
    const { task } = await submitting(f);
    assert.equal(JSON.parse(f.storage.get(learningKey)).hash, null);
    assert.equal(f.storage.get(key), JSON.stringify({ plan: { account, tx: { data: '0x1234' } }, hash: txHash }));
    f.provider.resolve(txHash); await task;
    assert.equal(busy.at(-1), true);
    assert.equal(JSON.parse(f.storage.get(learningKey)).hash, txHash);
  }, { plan: { account, tx: { data: '0x1234' } }, hash: txHash }, { marketId: 'learning', onBusy: value => busy.push(value) });
});
test('withdrawal has a separate review, shares pending locks and confirms the exact receiving address', async () => harness(async f => {
  const recipient='0x'+'44'.repeat(20);
  await f.click('connect-wallet');
  f.get('withdrawal-address').value=recipient;f.get('withdrawal-quantity').value='1.5';
  await f.click('review-withdraw');
  assert.equal(f.get('confirm-trade').textContent,'Confirm AUSD withdrawal');
  assert.ok(f.get('review-details').children.some(node=>node.textContent===`To: ${recipient}`));
  assert.equal(f.provider.calls.some(call=>call.method==='eth_sendTransaction'),false);
  f.get('withdrawal-quantity').handlers.input();
  assert.equal(f.get('confirm-trade').hidden,true);
  await f.click('review-withdraw');
  const task=f.click('confirm-trade');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.get('review-trade').disabled,true);assert.equal(f.get('review-withdraw').disabled,true);
  f.provider.resolve(txHash);await task;
  const plan=JSON.parse(f.storage.get(key)).plan;
  f.state.tx={status:'succeeded',confirmations:2,sender:account,to:cash,input:plan.tx.data,value_wei:'0',events:[{kind:'transfer',owner:account,recipient:pool,amount_atoms:'1500000'}]};
  await f.click('check-execution');assert.equal(f.storage.has(key),true);
  f.state.tx.events[0].recipient=recipient;
  await f.click('check-execution');assert.equal(f.storage.has(key),false);
  assert.match(f.get('execution-status').textContent,/Withdrawal confirmed: 1.5 AUSD/);
}));

test('pending request is recorded before wallet returns, blocks duplicate clicks, and survives account changes', async () => harness(async f => {
  const { task } = await submitting(f);
  assert.equal(JSON.parse(f.storage.get(key)).hash, null);
  await f.click('confirm-trade');
  f.provider.emit('chainChanged', '0x1');
  f.provider.resolve(txHash); await task;
  assert.equal(f.provider.calls.filter(c => c.method === 'eth_sendTransaction').length, 1);
  assert.equal(JSON.parse(f.storage.get(key)).hash, txHash);
  assert.equal(f.get('review-trade').disabled, true);
}));
test('explicit rejection releases tracking while uncertain wallet errors keep it locked', async () => {
  for (const code of [4001, -32603]) await harness(async f => {
    const { task } = await submitting(f);
    f.provider.reject(Object.assign(new Error('remote detail'), { code })); await task;
    assert.equal(f.storage.has(key), code !== 4001);
    assert.equal(f.get('execution-status').textContent.includes('remote detail'), false);
  });
});
test('confirmation requires two canonical confirmations and exact event before balances refresh', async () => harness(async f => {
  const { task } = await submitting(f); f.provider.resolve(txHash); await task;
  const plan = JSON.parse(f.storage.get(key)).plan;
  f.state.tx = { status: 'succeeded', confirmations: 1, sender: account, to: pool, input: plan.tx.data, value_wei: '0',
    events: [{ kind: 'trade', trader: account, scope: 3, mask: '8', is_buy: true, quantity_atoms: '1000000', collateral_atoms: '250001' }] };
  await f.click('check-execution'); assert.equal(f.storage.has(key), true);
  f.state.tx.confirmations = 2;
  await f.click('check-execution'); assert.equal(f.storage.has(key), false);
  assert.equal(f.state.refreshes, 1); assert.match(f.get('execution-status').textContent, /Buy confirmed for 1 claim units/);
}));
test('allowance reset and approval are explicitly separate from purchasing claims', async () => {
  for (const allowance of ['1', '0']) await harness(async f => {
    f.snapshot.wallet.pool_allowance_atoms = allowance;
    const { task } = await submitting(f);
    const reset = allowance === '1';
    assert.equal(f.get('confirm-trade').textContent, reset ? 'Confirm allowance reset in wallet' : 'Approve AUSD in wallet');
    f.provider.resolve(txHash); await task;
    const plan = JSON.parse(f.storage.get(key)).plan;
    assert.equal(plan.kind, 'approve');
    f.state.tx = { status: 'succeeded', confirmations: 2, sender: account, to: cash, input: plan.tx.data, value_wei: '0',
      events: [{ kind: 'approval', owner: account, spender: pool, amount_atoms: plan.approval }] };
    await f.click('check-execution');
    assert.equal(f.storage.has(key), false);
    assert.match(f.get('execution-status').textContent, reset ? /Allowance reset confirmed\. No claims bought/ : /AUSD approval confirmed\. No claims bought/);
    assert.equal(f.provider.calls.filter(c => c.method === 'eth_sendTransaction').length, 1);
  });
});
test('restored unresolved wallet requests lock new actions and are never automatically resubmitted', async () => harness(async f => {
  assert.equal(f.controller.busy, true);
  assert.equal(f.get('connect-wallet').disabled, true);
  assert.equal(f.provider.calls.length, 0);
}, { hash: null, plan: { account, tx: { data: '0x1234' } } }));

test('resolved winners and losers use explicit payout review and shared pending locks', async () => {
  for (const winning of [true, false]) await harness(async f => {
    f.snapshot.trading_available = false; f.snapshot.redemption_available = true;
    f.snapshot.pool = { resolved: true, phase: 'resolved', covered: true, receipt_backed: true, resolved_state: winning ? 3 : 0 };
    const payout = winning ? '1000000' : '0';
    f.provider.redemptionPayout = payout;
    f.snapshot.wallet.positions = [{ scope: 3, mask: 8, quantity_atoms: '1000000', settlement: winning ? 'winning' : 'losing', redeemable_atoms: payout }];
    await f.click('connect-wallet');
    assert.equal(f.get('review-redeem').disabled, false);
    await f.click('review-redeem');
    assert.equal(f.get('confirm-trade').textContent, winning ? 'Redeem winnings in wallet' : 'Confirm clearing for 0 AUSD in wallet');
    const task = f.click('confirm-trade');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.get('review-redeem').disabled, true);
    await f.click('review-redeem');
    f.provider.resolve(txHash); await task;
    const plan = JSON.parse(f.storage.get(key)).plan;
    f.state.tx = { status: 'succeeded', confirmations: 2, sender: account, to: pool, input: plan.tx.data, value_wei: '0',
      events: [{ kind: 'redemption', owner: account, scope: 3, mask: '8', quantity_atoms: '1000000', collateral_atoms: payout }] };
    await f.click('check-execution');
    assert.match(f.get('execution-status').textContent, winning ? /1 AUSD paid/ : /0 AUSD paid/);
    assert.equal(f.state.refreshes, 1);
    assert.equal(f.provider.calls.filter(c => c.method === 'eth_sendTransaction').length, 1);
  });
});

test('wrap and unwrap use a separate quantity, invalidate edits and block all actions until confirmed', async () => {
  for (const kind of ['wrap', 'unwrap']) await harness(async f => {
    f.snapshot.conversion_available = true; f.snapshot.pool.receipt_backed = true;
    f.snapshot.contracts.receipt = '0x' + '44'.repeat(20);
    f.snapshot.wallet.positions = [{ scope: 128, mask: 2, quantity_atoms: '2000000' }];
    f.snapshot.wallet.receipt_atoms = '2000000';
    await f.click('connect-wallet');
    assert.equal(f.get('review-' + kind).disabled, false);
    await f.click('review-' + kind);
    assert.equal(f.get('confirm-trade').textContent, `Confirm ${kind} in wallet`);
    f.get('conversion-quantity').value = '0.5'; f.get('conversion-quantity').handlers.input();
    assert.equal(f.get('confirm-trade').hidden, true);
    await f.click('review-' + kind);
    const task = f.click('confirm-trade'); await new Promise(resolve => setImmediate(resolve));
    const plan = JSON.parse(f.storage.get(key)).plan;
    assert.equal(plan.quantity, '500000'); assert.equal(plan.scope, 128);
    for (const id of ['review-wrap', 'review-unwrap', 'review-trade', 'review-redeem', 'setup-wallet', 'conversion-quantity']) assert.equal(f.get(id).disabled, true);
    await f.click('review-wrap'); await f.click('confirm-trade');
    f.provider.resolve(txHash); await task;
    f.state.tx = { status: 'succeeded', confirmations: 2, sender: account, to: pool, input: plan.tx.data, value_wei: '0',
      events: [{ kind, owner: account, scope: 128, mask: '2', quantity_atoms: '500000' }] };
    await f.click('check-execution');
    assert.match(f.get('execution-status').textContent, /0.5 H YES units converted 1:1/);
    assert.equal(f.state.refreshes, 1); assert.equal(f.storage.has(key), false);
    assert.equal(f.provider.calls.filter(c => c.method === 'eth_sendTransaction').length, 1);
  });
});
