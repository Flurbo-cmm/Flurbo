import test from 'node:test';
import assert from 'node:assert/strict';
import { makePlan, prepare, makeRedemptionPlan, prepareRedemption, makeConversionPlan, prepareConversion, makeWithdrawalPlan, prepareWithdrawal, assertContext, sendReviewed, reconcile, setupLocalWallet, encode, boundFor, walletMessage } from './wallet.mjs';

const ACCOUNT = '0x' + '11'.repeat(20), POOL = '0x' + '22'.repeat(20), CASH = '0x' + '33'.repeat(20);
test('quotes and reviewed transactions cannot be reused across pool selections', async () => {
  const f = fixture();
  const quote = f.quoted || f.quote;
  f.snapshot.market_id = 'learning';
  assert.throws(() => makePlan(f.snapshot, quote, ACCOUNT, 50), /matching quote/);
  quote.market_id = 'learning'; quote.contracts = { ...f.snapshot.contracts };
  const plan = makePlan(f.snapshot, quote, ACCOUNT, 50);
  quote.contracts.pool = CASH;
  assert.throws(() => makePlan(f.snapshot, quote, ACCOUNT, 50), /matching quote/);
  f.snapshot.contracts.pool = CASH;
  await assert.rejects(sendReviewed(f.provider, plan, f.snapshot), /Deployment changed/);
  assert.equal(f.calls.filter(c => c.method === 'eth_sendTransaction').length, 0);
});
function convertible() {
  const f = fixture();
  f.snapshot.contracts.receipt = '0x' + '44'.repeat(20);
  f.snapshot.conversion_available = true;
  f.snapshot.pool = { phase: 'resolved', resolved: true, covered: false, receipt_backed: true };
  f.snapshot.trading_available = false;
  f.snapshot.wallet.positions = [{ scope: 128, mask: 2, quantity_atoms: '1000000' }];
  f.snapshot.wallet.receipt_atoms = '1000000';
  f.overrides.eth_call = () => '0x';
  return f;
}
test('canonical H YES conversions need no approval, pay no AUSD and work after resolution/shortfall', async () => {
  for (const [kind, selector] of [['wrap', 'b0a52172'], ['unwrap', 'f6c4eade']]) {
    const f = convertible();
    const plan = await prepareConversion(f.provider, f.snapshot, kind, ACCOUNT, '500000');
    assert.equal(plan.kind, kind); assert.equal(plan.scope, 128); assert.equal(plan.mask, 2);
    assert.equal(plan.tx.data, encode(selector, 7, 1, 500000)); assert.equal(plan.tx.value, '0x0');
    await sendReviewed(f.provider, plan, f.snapshot);
    assert.equal(f.calls.filter(c => c.method === 'eth_sendTransaction').length, 1);
    const event = { kind, owner: ACCOUNT, scope: 128, mask: '2', quantity_atoms: '500000' };
    const tx = { status: 'succeeded', sender: ACCOUNT, to: POOL, input: plan.tx.data, value_wei: '0', events: [event] };
    assert.equal(reconcile(plan, tx), 'matched');
    for (const change of [{ kind: kind === 'wrap' ? 'unwrap' : 'wrap' }, { owner: CASH }, { scope: 3 }, { mask: '1' }, { quantity_atoms: '1' }]) {
      tx.events = [{ ...event, ...change }]; assert.equal(reconcile(plan, tx), 'mismatch');
    }
    tx.events = [event, { ...event }]; assert.equal(reconcile(plan, tx), 'mismatch');
  }
});
test('conversion rejects invalid holdings, stale backing and changed receipts before sending', async () => {
  for (const change of [f => f.snapshot.wallet.address = CASH, f => f.snapshot.snapshot.stale = true,
    f => f.snapshot.pool.receipt_backed = false, f => f.snapshot.conversion_available = false,
    f => f.snapshot.environment = 'public_testnet']) {
    const f = convertible(); change(f);
    for (const kind of ['wrap', 'unwrap']) assert.throws(() => makeConversionPlan(f.snapshot, kind, ACCOUNT, '1'));
  }
  const f = convertible();
  for (const kind of ['wrap', 'unwrap']) for (const qty of ['0', '-1', '1000001']) assert.throws(() => makeConversionPlan(f.snapshot, kind, ACCOUNT, qty));
  f.snapshot.wallet.positions = [{ scope: 3, mask: 8, quantity_atoms: '99999999' }];
  assert.throws(() => makeConversionPlan(f.snapshot, 'wrap', ACCOUNT, '1'), /internal H YES/);
  f.snapshot.wallet.receipt_atoms = '0'; f.snapshot.wallet.margin_available_receipt_atoms = '99999999';
  assert.throws(() => makeConversionPlan(f.snapshot, 'unwrap', ACCOUNT, '1'), /withdrawn first/);
  const ready = convertible();
  ready.overrides.eth_call = () => encode('', 1);
  await assert.rejects(prepareConversion(ready.provider, ready.snapshot, 'wrap', ACCOUNT, '1'), /simulation result/);
  ready.overrides.eth_call = () => '0x';
  const plan = await prepareConversion(ready.provider, ready.snapshot, 'wrap', ACCOUNT, '1');
  ready.snapshot.contracts.receipt = CASH;
  await assert.rejects(sendReviewed(ready.provider, plan, ready.snapshot), /Receipt or conversion changed/);
  assert.equal(ready.calls.some(c => c.method === 'eth_sendTransaction'), false);
});
function settled() {
  const f = fixture();
  f.snapshot.redemption_available = true; f.snapshot.trading_available = false;
  f.snapshot.pool = { resolved: true, resolved_state: 129, covered: true, receipt_backed: true };
  f.snapshot.wallet.positions = [{ scope: 129, mask: 8, quantity_atoms: '1000000' }, { scope: 129, mask: 1, quantity_atoms: '1000000' }];
  return f;
}
test('redemption projects sparse scopes, supports partial winners and zero-payout losers without approval', async () => {
  for (const [mask, payout] of [[8, '500000'], [1, '0']]) {
    const f = settled(); f.overrides.eth_call = () => encode('', payout);
    const plan = await prepareRedemption(f.provider, f.snapshot, { scope: 129, mask }, ACCOUNT, '500000');
    assert.equal(plan.kind, 'redeem'); assert.equal(plan.payout, payout);
    assert.equal(plan.tx.data, encode('df992423', 129, mask, 500000));
    await sendReviewed(f.provider, plan, f.snapshot);
    assert.equal(f.calls.filter(c => c.method === 'eth_sendTransaction').length, 1);
    const tx = { status: 'succeeded', sender: ACCOUNT, to: POOL, input: plan.tx.data, value_wei: '0', events: [
      { kind: 'redemption', owner: ACCOUNT, scope: 129, mask: String(mask), quantity_atoms: '500000', collateral_atoms: payout }] };
    assert.equal(reconcile(plan, tx), 'matched');
    tx.events[0].collateral_atoms = '1'; assert.equal(reconcile(plan, tx), 'mismatch');
    tx.events[0].collateral_atoms = payout; tx.events.push({ ...tx.events[0] }); assert.equal(reconcile(plan, tx), 'mismatch');
  }
});
test('redemption rejects stale unresolved shortfall wrong-owner and excessive quantities, and rechecks outcome', async () => {
  for (const change of [f => f.snapshot.pool.resolved = false, f => f.snapshot.pool.covered = false,
    f => f.snapshot.pool.receipt_backed = false, f => f.snapshot.snapshot.stale = true,
    f => f.snapshot.wallet.address = CASH, f => f.snapshot.wallet.positions = [], f => f.snapshot.environment = 'public_testnet']) {
    const f = settled(); change(f);
    assert.throws(() => makeRedemptionPlan(f.snapshot, { scope: 129, mask: 8 }, ACCOUNT, '500000'));
  }
  const f = settled();
  for (const quantity of ['0', '-1', '1000001']) assert.throws(() => makeRedemptionPlan(f.snapshot, { scope: 129, mask: 8 }, ACCOUNT, quantity));
  f.overrides.eth_call = () => encode('', 1);
  await assert.rejects(prepareRedemption(f.provider, f.snapshot, { scope: 129, mask: 8 }, ACCOUNT, '500000'), /Simulation/);
  f.overrides.eth_call = () => encode('', 500000);
  const plan = await prepareRedemption(f.provider, f.snapshot, { scope: 129, mask: 8 }, ACCOUNT, '500000');
  f.snapshot.pool.resolved_state = 0;
  await assert.rejects(sendReviewed(f.provider, plan, f.snapshot), /Settlement changed/);
  assert.equal(f.calls.some(c => c.method === 'eth_sendTransaction'), false);
});
function fixture() {
  const now = Math.floor(Date.now() / 1000);
  const snapshot = { environment: 'local_fork', chain_id: 10143, snapshot: { timestamp: now, stale: false, block_number: 100, block_hash: '0x' + 'aa'.repeat(32) },
    trading_available: true, contracts: { pool: POOL, cash: CASH }, cluster: { closes_at: now + 1000 },
    wallet: { address: ACCOUNT, ausd_atoms: '10000000', native_balance_wei: '1000000000000000000', pool_allowance_atoms: '1000000', positions: [{ scope: 3, mask: 8, quantity_atoms: '1000000' }] } };
  const quoted = { environment: 'local_fork', chain_id: 10143, snapshot: { ...snapshot.snapshot }, quote: { side: 'buy', scope: 3, mask: 8, quantity_atoms: '1000000', collateral_atoms: '250001', valid_until: now + 300 } };
  const calls = [], overrides = {};
  const provider = { async request({ method, params }) {
    calls.push({ method, params });
    if (overrides[method]) return overrides[method](params);
    return { eth_accounts: [ACCOUNT], eth_chainId: '0x279f', eth_getBlockByNumber: { hash: snapshot.snapshot.block_hash },
      eth_call: '0x' + BigInt(250001).toString(16).padStart(64, '0'), eth_estimateGas: '0x186a0', eth_gasPrice: '0x3b9aca00', eth_sendTransaction: '0x' + '55'.repeat(32) }[method];
  } };
  return { snapshot, quoted, provider, calls, overrides };
}

test('public Monad testnet trades, conversions and redemptions retain snapshot and collateral checks', async () => {
  const cash = '0xa9012a055bd4e0edff8ce09f960291c09d5322dc';
  const f = fixture(); f.snapshot.environment = f.quoted.environment = 'public_testnet'; f.snapshot.contracts.cash = cash;
  for (const side of ['buy', 'sell']) {
    f.quoted.quote.side = side;
    const plan = await prepare(f.provider, f.snapshot, f.quoted, ACCOUNT, 50);
    assert.equal(plan.kind, side);
    await sendReviewed(f.provider, plan, f.snapshot);
  }
  f.overrides.eth_getBlockByNumber = () => ({hash: '0x' + 'bb'.repeat(32)});
  await assert.rejects(assertContext(f.provider, f.snapshot, ACCOUNT), /public Monad testnet/);
  f.quoted.environment = 'local_fork'; assert.throws(() => makePlan(f.snapshot, f.quoted, ACCOUNT, 50));
  const c = convertible(); c.snapshot.environment = 'public_testnet'; c.snapshot.contracts.cash = cash;
  assert.equal((await prepareConversion(c.provider, c.snapshot, 'wrap', ACCOUNT, '1')).kind, 'wrap');
  const r = settled(); r.snapshot.environment = 'public_testnet'; r.snapshot.contracts.cash = cash;
  assert.equal(makeRedemptionPlan(r.snapshot, {scope:129,mask:8}, ACCOUNT, '1').kind, 'redeem');
});

test('withdrawal sends only available wallet AUSD with exact destination and transfer receipt', async () => {
  const f = fixture(), recipient = '0x' + '44'.repeat(20);
  f.snapshot.trading_available = false;
  f.overrides.eth_call = () => encode('', 1);
  const plan = await prepareWithdrawal(f.provider, f.snapshot, ACCOUNT, recipient, '1500000');
  assert.equal(plan.tx.to, CASH); assert.equal(plan.tx.data, encode('a9059cbb', recipient, 1500000));
  assert.equal(f.calls.some(call => call.method === 'eth_sendTransaction'), false);
  await sendReviewed(f.provider, plan, f.snapshot);
  assert.equal(f.calls.filter(call => call.method === 'eth_sendTransaction').length, 1);
  const event = {kind:'transfer', owner:ACCOUNT, recipient, amount_atoms:'1500000'};
  const receipt = {status:'succeeded', sender:ACCOUNT, to:CASH, input:plan.tx.data, value_wei:'0', events:[event]};
  assert.equal(reconcile(plan, receipt), 'matched');
  for (const change of [{recipient:POOL}, {amount_atoms:'1'}, {owner:CASH}, {kind:'approval'}]) {
    assert.equal(reconcile(plan, {...receipt, events:[{...event,...change}]}), 'mismatch');
  }
  assert.equal(reconcile(plan, {...receipt,events:[event,event]}),'mismatch');
});

test('withdrawal rejects invalid recipients, locked position value, insufficient funds and changed review', async () => {
  const f = fixture(), recipient = '0x' + '44'.repeat(20);
  for(const invalid of ['0x'+'00'.repeat(20),ACCOUNT,POOL,CASH,'invalid']) assert.throws(()=>makeWithdrawalPlan(f.snapshot,ACCOUNT,invalid,'1'));
  for(const amount of ['0','-1','10000001']) assert.throws(()=>makeWithdrawalPlan(f.snapshot,ACCOUNT,recipient,amount));
  f.snapshot.wallet.ausd_atoms = '0'; f.snapshot.wallet.positions = [{scope:1,mask:2,quantity_atoms:'999999999'}];
  assert.throws(()=>makeWithdrawalPlan(f.snapshot,ACCOUNT,recipient,'1'),/available AUSD/);
  f.snapshot.wallet.ausd_atoms='1000000'; f.overrides.eth_call=()=>encode('',1);
  const plan=await prepareWithdrawal(f.provider,f.snapshot,ACCOUNT,recipient,'500000');
  await assert.rejects(sendReviewed(f.provider,{...plan,recipient:POOL},f.snapshot));
  f.snapshot.wallet.ausd_atoms='1'; await assert.rejects(sendReviewed(f.provider,plan,f.snapshot));
  assert.equal(f.calls.some(call=>call.method==='eth_sendTransaction'),false);
});

test('buy calldata uses factored scope/mask, capped integer slippage and contract deadline', () => {
  const { snapshot, quoted } = fixture();
  const p = makePlan(snapshot, quoted, ACCOUNT, 50, snapshot.snapshot.timestamp);
  assert.equal(p.limit, '251252'); assert.equal(p.kind, 'buy');
  assert.equal(p.tx.data, encode('3e6b6cde', 3, 8, 1000000, 251252, p.deadline));
  assert.equal(p.tx.chainId, '0x279f'); assert.equal(p.tx.value, '0x0');
  assert.equal(p.deadline, quoted.quote.valid_until + 120);
  assert.equal(boundFor({ ...quoted.quote, collateral_atoms: '1000000' }, 500), 1000000n);
});

test('automatic setup requests exact local network configuration and funds only after fork verification', async () => {
  const f = fixture(); let switched = false, funded = false;
  f.overrides.eth_requestAccounts = () => [ACCOUNT];
  f.overrides.eth_getBlockByNumber = () => ({ hash: switched ? f.snapshot.snapshot.block_hash : '0x' + 'bb'.repeat(32) });
  f.overrides.wallet_addEthereumChain = params => {
    assert.equal(params[0].chainId, '0x279f'); assert.deepEqual(params[0].rpcUrls, ['http://127.0.0.1:18545']); return null;
  };
  f.overrides.wallet_switchEthereumChain = () => { switched = true; return null; };
  const owner = await setupLocalWallet(f.provider, {
    readHealth: async () => ({ local_wallet_setup: true }), readSnapshot: async () => f.snapshot,
    fundLocal: async candidate => { assert.equal(candidate, ACCOUNT); assert.equal(switched, true); funded = true; f.snapshot.wallet.native_balance_wei = '10000000000000000000'; },
  });
  assert.equal(owner, ACCOUNT); assert.equal(funded, true);
  assert.equal(f.calls.some(c => c.method === 'eth_sendTransaction'), false);
});
test('setup never funds on rejected prompts, unchanged public RPC, or changed account', async () => {
  for (const reason of ['rejected', 'wrong_fork', 'account_changed', 'disabled']) {
    const f = fixture(); let funded = false;
    f.overrides.eth_requestAccounts = () => [ACCOUNT];
    f.overrides.eth_getBlockByNumber = () => ({ hash: '0x' + 'bb'.repeat(32) });
    f.overrides.wallet_addEthereumChain = () => { if (reason === 'rejected') throw Object.assign(new Error(), { code: 4001 }); return null; };
    f.overrides.wallet_switchEthereumChain = () => { if (reason === 'account_changed') f.overrides.eth_accounts = () => [CASH]; return null; };
    await assert.rejects(setupLocalWallet(f.provider, { readHealth: async () => ({ local_wallet_setup: reason !== 'disabled' }),
      readSnapshot: async () => f.snapshot, fundLocal: async () => { funded = true; } }));
    assert.equal(funded, false);
    if (reason === 'disabled') assert.equal(f.calls.length, 0);
  }
});
test('older reviewed quotes keep their limits while fresh execution state and simulation remain mandatory', async () => {
  const f = fixture(), now = Math.floor(Date.now() / 1000);
  f.quoted.snapshot.timestamp = now - 240;
  f.quoted.quote.valid_until = now + 60;
  const plan = await prepare(f.provider, f.snapshot, f.quoted, ACCOUNT, 50);
  assert.equal(plan.limit, '251252');
  assert.equal(plan.deadline, now + 180);
  f.overrides.eth_call = () => encode('', 251253);
  await assert.rejects(sendReviewed(f.provider, plan, f.snapshot), /Simulation/);
  assert.equal(f.calls.some(call => call.method === 'eth_sendTransaction'), false);
  f.snapshot.snapshot.timestamp = now - 31;
  assert.throws(() => makePlan(f.snapshot, f.quoted, ACCOUNT, 50), /expired/);
  f.snapshot.snapshot.timestamp = now;
  f.snapshot.cluster.closes_at = now + 40;
  assert.equal(makePlan(f.snapshot, f.quoted, ACCOUNT, 50).deadline, now + 39);
});

test('approvals are exact and a nonzero insufficient allowance is reset in a separate transaction', () => {
  const { snapshot, quoted } = fixture(); snapshot.wallet.pool_allowance_atoms = '0';
  const p = makePlan(snapshot, quoted, ACCOUNT, 50);
  assert.equal(p.kind, 'approve'); assert.equal(p.approval, '251252'); assert.equal(p.tx.to, CASH);
  assert.equal(p.tx.data, encode('095ea7b3', POOL, 251252));
  snapshot.wallet.pool_allowance_atoms = '1';
  assert.equal(makePlan(snapshot, quoted, ACCOUNT, 50).approval, '0');
});
test('sell floors proceeds and requires the precise internal claim holding', () => {
  const { snapshot, quoted } = fixture(); quoted.quote.side = 'sell';
  const p = makePlan(snapshot, quoted, ACCOUNT, 50);
  assert.equal(p.kind, 'sell'); assert.equal(p.limit, '248750');
  assert.equal(p.tx.data.slice(0, 10), '0xc39849c5');
  snapshot.wallet.positions[0].mask = 7;
  assert.throws(() => makePlan(snapshot, quoted, ACCOUNT, 50), /internal pool units/);
  assert.throws(() => boundFor({ ...quoted.quote, collateral_atoms: '1' }, 500), /zero/);
});
test('stale, closed, wrong account, unfunded and public manifests cannot produce a transaction', () => {
  for (const change of [
    f => { f.snapshot.environment = 'public_testnet'; }, f => { f.quoted.environment = 'public_testnet'; },
    f => { f.snapshot.trading_available = false; }, f => { f.snapshot.snapshot.stale = true; },
    f => { f.quoted.quote.valid_until = 0; }, f => { f.snapshot.wallet.address = CASH; },
    f => { f.snapshot.wallet.ausd_atoms = '0'; }, f => { f.quoted.quote.scope = 15; },
  ]) { const f = fixture(); change(f); assert.throws(() => makePlan(f.snapshot, f.quoted, ACCOUNT, 50)); }
});
test('chain ID alone cannot authorize the public network or another fork', async () => {
  const f = fixture(); f.overrides.eth_getBlockByNumber = () => ({ hash: '0x' + 'bb'.repeat(32) });
  await assert.rejects(assertContext(f.provider, f.snapshot, ACCOUNT), /same chain ID/);
  assert.equal(f.calls.some(c => c.method === 'eth_sendTransaction'), false);
});
test('account and chain mismatches stop before simulation or submission', async () => {
  for (const [method, value] of [['eth_accounts', [CASH]], ['eth_chainId', '0x1']]) {
    const f = fixture(); f.overrides[method] = () => value;
    await assert.rejects(assertContext(f.provider, f.snapshot, ACCOUNT));
    assert.equal(f.calls.some(c => c.method === 'eth_sendTransaction'), false);
  }
});
test('review simulates, pads gas, fixes a fee budget, and never submits', async () => {
  const f = fixture(); const p = await prepare(f.provider, f.snapshot, f.quoted, ACCOUNT, 50);
  assert.equal(BigInt(p.tx.gas), 120000n); assert.equal(BigInt(p.tx.gasPrice), 2000000000n);
  assert.equal(p.gasBudget, '240000000000000');
  assert.equal(f.calls.some(c => c.method === 'eth_sendTransaction'), false);
  f.snapshot.wallet.native_balance_wei = '0';
  await assert.rejects(prepare(f.provider, f.snapshot, f.quoted, ACCOUNT, 50), /MON/);
});
test('confirmation rechecks context and simulation and sends exactly the reviewed fields once', async () => {
  const f = fixture(); const p = await prepare(f.provider, f.snapshot, f.quoted, ACCOUNT, 50);
  let recorded = false;
  await sendReviewed(f.provider, p, f.snapshot, () => true, () => { recorded = true; });
  assert.equal(recorded, true);
  assert.deepEqual(f.calls.filter(c => c.method === 'eth_sendTransaction'), [{ method: 'eth_sendTransaction', params: [p.tx] }]);
});
test('changed inputs during preflight, expired reviews and failed simulations cannot send', async () => {
  const f = fixture(); const p = makePlan(f.snapshot, f.quoted, ACCOUNT, 50);
  let current = true;
  f.overrides.eth_call = () => { current = false; return '0x' + (250001).toString(16).padStart(64, '0'); };
  await assert.rejects(sendReviewed(f.provider, p, f.snapshot, () => current), /changed/);
  p.quoteExpiry = 0;
  await assert.rejects(sendReviewed(f.provider, p, f.snapshot), /expired/);
  assert.equal(f.calls.some(c => c.method === 'eth_sendTransaction'), false);
});
test('rejected wallet submission is never retried', async () => {
  const f = fixture(); const p = makePlan(f.snapshot, f.quoted, ACCOUNT, 50);
  f.overrides.eth_sendTransaction = () => { throw Object.assign(new Error(), { code: 4001 }); };
  await assert.rejects(sendReviewed(f.provider, p, f.snapshot), { code: 4001 });
  assert.equal(f.calls.filter(c => c.method === 'eth_sendTransaction').length, 1);
  assert.match(walletMessage({ code: 4001 }), /rejected/);
});
test('receipt success must match exact input, sender, target, zero value and one bounded trade event', () => {
  const f = fixture(), p = makePlan(f.snapshot, f.quoted, ACCOUNT, 50);
  const event = { kind: 'trade', trader: ACCOUNT, scope: 3, mask: '8', is_buy: true, quantity_atoms: '1000000', collateral_atoms: '250001' };
  const tx = { status: 'succeeded', sender: ACCOUNT, to: POOL, input: p.tx.data, value_wei: '0', events: [event] };
  assert.equal(reconcile(p, tx), 'matched');
  for (const bad of [{ sender: CASH }, { to: CASH }, { input: '0x' }, { value_wei: '1' }, { events: [] }, { events: [event, event] }, { events: [{ ...event, collateral_atoms: '999999' }] }]) assert.equal(reconcile(p, { ...tx, ...bad }), 'mismatch');
  assert.equal(reconcile(p, { ...tx, status: 'reverted', events: [] }), 'reverted');
  assert.equal(reconcile(p, { status: 'unknown' }), 'pending');
});
