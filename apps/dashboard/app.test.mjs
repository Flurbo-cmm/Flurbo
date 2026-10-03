// Exercise dashboard refresh/timer behavior together with the real trading controller.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const account = '0x' + '11'.repeat(20), pool = '0x' + '22'.repeat(20), cash = '0xa9012a055bd4e0edff8ce09f960291c09d5322dc';
const blockHash = number => '0x' + number.toString(16).padStart(64, '0');
const flush = () => new Promise(resolve => setImmediate(resolve));

async function harness(run, options = {}) {
  const keys = ['window', 'document', 'fetch', 'sessionStorage', 'setInterval', 'clearInterval'];
  const previous = Object.fromEntries(keys.map(key => [key, globalThis[key]])), realNow = Date.now;
  let now = 1000, dispose, holdState = false, statePatch = {}, allowance = '0', quoteFailure = false;
  const nodes = new Map(), timers = [], requests = [], held = [], storage = new Map();
  class Node {
    value = ''; textContent = ''; children = []; hidden = false; disabled = false; handlers = {};
    classList = { toggle() {} };
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute() {}
    addEventListener(type, fn) { this.handlers[type] = fn; }
  }
  const get = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  const snapshot = wallet => ({environment: 'public_testnet', chain_id: 10143, trading_available: true,
    snapshot: {timestamp: now, block_number: now, block_hash: blockHash(now), stale: false},
    contracts: {pool, cash}, cluster: {closes_at: 2000, resolver: account, rules: 'synthetic', events: []},
    pool: {phase: 'open', covered: true, receipt_backed: true, resolved: false, pool_collateral_atoms: '61000000',
      required_collateral_atoms: '10000000', coverage_surplus_atoms: '51000000', receipt_supply_atoms: '10000000'},
    kuru: {best_bid_wad: null, best_ask_wad: null},
    wallet: wallet ? {address: wallet, ausd_atoms: '10000000', native_balance_wei: '1000000000000000000',
      pool_allowance_atoms: allowance, receipt_atoms: '0', margin_available_ausd_atoms: '0', margin_available_receipt_atoms: '0', positions: []} : null,
    ...statePatch});
  class Provider extends EventEmitter {
    calls = []; simulate; sendSucceeds = false;
    async request({method, params}) {
      this.calls.push(method);
      if (method === 'eth_call') {
        if (this.simulate) { const fn = this.simulate; this.simulate = null; await fn(); }
        return '0x' + '1'.padStart(64, '0');
      }
      if (method === 'eth_getBlockByNumber') return {hash: blockHash(Number(BigInt(params[0])))};
      if (method === 'eth_sendTransaction') {
        if (this.sendSucceeds) return '0x' + 'ab'.repeat(32);
        throw Object.assign(new Error('Test wallet rejection'), {code: 4001});
      }
      return {eth_requestAccounts: [account], eth_accounts: [account], eth_chainId: '0x279f',
        eth_estimateGas: '0x186a0', eth_gasPrice: '0x3b9aca00'}[method];
    }
  }
  const provider = new Provider();
  try {
    Date.now = () => now * 1000;
    globalThis.document = Object.assign(new EventTarget(), {hidden: false, querySelector: () => null, createElement: () => new Node()});
    globalThis.window = Object.assign(new EventTarget(), {ethereum: provider});
    globalThis.sessionStorage = {getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key)};
    globalThis.setInterval = (fn, ms) => { timers.push({fn, ms}); return timers.length; };
    globalThis.clearInterval = () => {};
    globalThis.fetch = async path => {
      requests.push(path);
      const url = new URL(path, 'http://localhost');
      if (url.pathname === '/api/transaction') {
        const plan = JSON.parse(storage.get('flurbo.local.pending.v1')).plan;
        allowance = plan.approval;
        return Response.json({transaction: {status: 'succeeded', confirmations: 2, sender: account, to: cash,
          input: plan.tx.data, value_wei: '0', events: [{kind: 'approval', owner: account, spender: pool, amount_atoms: allowance}]}});
      }
      if (url.pathname === '/api/state') {
        if (holdState) { holdState = false; return new Promise(resolve => held.push(() => resolve(Response.json(snapshot(url.searchParams.get('wallet')))))) ; }
        return Response.json(snapshot(url.searchParams.get('wallet')));
      }
      if (url.pathname === '/api/quote' && quoteFailure) return Response.json({error: 'Pool unavailable'}, {status: 503});
      if (url.pathname === '/api/quote') return Response.json({environment: 'public_testnet', chain_id: 10143,
        snapshot: snapshot().snapshot, quote: {side: 'buy', scope: 128, mask: 2, quantity_atoms: '1000000', collateral_atoms: '740737', valid_until: now + 300}});
      throw new Error('Unexpected test request');
    };
    get('mode').value = 'all'; get('side').value = 'buy'; get('quantity').value = '1';
    get('conversion-quantity').value = '1'; get('slippage').value = '50';
    const {mountDashboard} = await import('./app.mjs');
    dispose = mountDashboard({querySelector: selector => get(selector.slice(1))}, options);
    await flush();
    const click = id => get(id).handlers.click();
    await click('connect-wallet'); await flush();
    await run({get, click, provider, requests, held, advance: seconds => {now += seconds;},
      failQuote: () => {quoteFailure = true;},
      hold: () => {holdState = true;}, patch: value => {statePatch = value;},
      tick: () => timers.find(t => t.ms === 1000).fn(), refresh: () => timers.find(t => t.ms === 15000).fn(),
      visible: () => document.dispatchEvent(new Event('visibilitychange'))});
  } finally {
    dispose?.(); held.forEach(resolve => resolve()); await flush(); Date.now = realNow;
    for (const key of keys) { if (previous[key] === undefined) delete globalThis[key]; else globalThis[key] = previous[key]; }
  }
}

test('consumer review fetches a price and approval continuation prepares a buy without automatically signing', async () => harness(async f => {
  assert.equal(f.get('review-trade').disabled, false);
  await f.click('review-trade');
  assert.equal(f.requests.filter(path => path.startsWith('/api/quote')).length, 1);
  assert.equal(f.get('review-trade').hidden, true);
  assert.equal(f.get('confirm-trade').textContent, 'Approve AUSD in wallet');
  assert.equal(f.provider.calls.includes('eth_sendTransaction'), false);
  f.provider.sendSucceeds = true;
  await f.click('confirm-trade'); await flush();
  assert.equal(f.get('review-trade').textContent, 'Continue to buy');
  assert.match(f.get('execution-status').textContent, /No claims bought yet/);
  await f.click('review-trade');
  assert.equal(f.requests.filter(path => path.startsWith('/api/quote')).length, 2);
  assert.equal(f.get('confirm-trade').textContent, 'Confirm buy in wallet');
  assert.equal(f.provider.calls.filter(method => method === 'eth_sendTransaction').length, 1);
  assert.ok(f.get('review-details').children.some(node => node.textContent.includes('H YES')));
}, {consumer: true}));

test('consumer price errors and edits during preflight cannot open confirmation or submit', async () => {
  for (const reason of ['quote-error', 'edited']) await harness(async f => {
    if (reason === 'quote-error') f.failQuote();
    else f.provider.simulate = async () => { f.get('quantity').value = '2'; f.get('quantity').handlers.input(); };
    await f.click('review-trade');
    assert.equal(f.get('confirm-trade').hidden, true);
    assert.equal(f.get('review-trade').hidden, false);
    assert.equal(f.provider.calls.includes('eth_sendTransaction'), false);
  }, {consumer: true});
});

test('a quote can be reviewed after four minutes and still open the wallet after fresh preflight', async () => harness(async f => {
  await f.click('quote-button');
  f.advance(240); f.tick();
  assert.equal(f.get('quote-expiry').textContent, '1:00 to review');
  await f.click('review-trade');
  assert.equal(f.get('confirm-trade').hidden, false);
  await f.click('confirm-trade');
  assert.equal(f.provider.calls.filter(method => method === 'eth_sendTransaction').length, 1);
}));

test('new quote survives an older display snapshot expiring during review and reaches the wallet', async () => harness(async f => {
  f.advance(20); await f.click('quote-button');
  f.provider.simulate = async () => { f.advance(11); f.tick(); };
  await f.click('review-trade');
  assert.equal(f.get('confirm-trade').hidden, false);
  assert.equal(f.get('confirm-trade').textContent, 'Approve AUSD in wallet');
  await f.click('confirm-trade');
  assert.equal(f.provider.calls.filter(method => method === 'eth_sendTransaction').length, 1);
  assert.match(f.get('execution-status').textContent, /rejected/);
}));

test('a previously started background refresh at a newer block does not invalidate an active review', async () => harness(async f => {
  f.advance(10); f.hold(); f.refresh(); await flush();
  await f.click('quote-button');
  f.advance(1);
  f.provider.simulate = async () => { f.held.shift()(); await flush(); };
  await f.click('review-trade');
  assert.equal(f.get('confirm-trade').hidden, false);
  const requests = f.requests.length;
  f.visible(); await flush();
  assert.equal(f.requests.length, requests, 'returning from the wallet must not start a competing refresh');
  await f.click('confirm-trade');
  assert.equal(f.provider.calls.filter(method => method === 'eth_sendTransaction').length, 1);
}));

test('quote expiry and user input changes still cancel reviews before submission', async () => {
  for (const reason of ['expiry', 'input']) await harness(async f => {
    await f.click('quote-button'); await f.click('review-trade');
    if (reason === 'expiry') { f.advance(301); f.tick(); }
    else { f.get('quantity').value = '2'; f.get('quantity').handlers.input(); }
    assert.equal(f.get('confirm-trade').hidden, true);
    await f.click('confirm-trade');
    assert.equal(f.provider.calls.includes('eth_sendTransaction'), false);
  });
});

test('newly observed closed markets and changed deployments still cancel active reviews', async () => {
  for (const change of [{trading_available: false}, {contracts: {pool: '0x' + '44'.repeat(20), cash}}]) await harness(async f => {
    f.hold(); f.refresh(); await flush();
    await f.click('quote-button'); await f.click('review-trade');
    f.advance(1); f.patch(change); f.held.shift()(); await flush();
    assert.equal(f.get('confirm-trade').hidden, true);
    await f.click('confirm-trade');
    assert.equal(f.provider.calls.includes('eth_sendTransaction'), false);
  });
});
