import { compileClaim, claimLabel, parseUnits, formatUnits, snapshotFresh, quoteReviewable } from './claims.mjs';
import { mountTrading } from './trading-ui.mjs';

export function mountDashboard(root = document, options = {}) {
const $ = id => root.querySelector('#' + id);
let disposed = false;
const text = (id, value) => { $(id).textContent = value; };
function el(tag, value, className) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (className) node.className = className;
  return node;
}
let legs = [{ index: 7, yes: true }], customMask = 2, composed, quantityValid = true;
let data = null, wallet = options.account || null, stateBusy = false, quoteBusy = false, quote = null;
let stateGeneration = 0, quoteGeneration = 0, txGeneration = 0;
let stateController, quoteController, txController;
let lastFailure = '', selectedLabels = new Map();
let trading;

const requestCredentials = options.credentials || 'omit';
const marketId = options.marketId === 'learning' ? 'learning' : 'original';
async function request(path, controller, options = {}) {
  // Let the gateway's 20-second timeout return its error before aborting locally.
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const selectedPath = marketId === 'learning' ? path.replace(/^\/api\//, '/api/markets/learning/') : path;
    const response = await fetch(selectedPath, { ...options, signal: controller.signal, cache: 'no-store', credentials: requestCredentials });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Data is unavailable. Try refreshing.');
    if (/^\/api\/(state|quote|transaction)(\?|$)/.test(path) && (result.market_id || 'original') !== marketId) throw new Error('Market response does not match your selection. Refresh before trading.');
    return result;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Request interrupted or timed out. Try again.');
    if (error instanceof TypeError) throw new Error('Cannot reach the market service. Please try again shortly.');
    throw error;
  } finally { clearTimeout(timeout); }
}

function emptyQuote(message = 'Build a claim, then request a quote.') {
  trading?.invalidate();
  quote = null;
  $('quote-result').replaceChildren(el('p', message, 'quote-empty'));
}
function invalidateQuote(message) {
  ++quoteGeneration;
  quoteController?.abort();
  quoteBusy = false;
  emptyQuote(message);
}
function preview() {
  try {
    composed = compileClaim(legs, $('mode').value, customMask);
    text('compose-error', '');
    text('claim-label', claimLabel(legs, $('mode').value));
    text('claim-detail', options.consumer ? 'Pays 1 AUSD per winning unit at settlement.' : `Pays 1 AUSD per winning unit · scope ${composed.scope}, mask ${composed.mask}`);
  } catch (error) {
    composed = null;
    text('compose-error', error.message);
    text('claim-label', legs.length ? claimLabel(legs, $('mode').value) : 'Choose your events');
    text('claim-detail', 'A valid claim needs both winning and losing outcomes.');
  }
  quantityValid = true;
  try { parseUnits($('quantity').value.trim()); }
  catch (error) { quantityValid = false; if (composed) text('compose-error', error.message); }
  tick();
}
function changeClaim(rebuild = false) {
  invalidateQuote('Claim changed. Request a new pool quote.');
  if (rebuild) renderComposer();
  preview();
  // Invalidate old position responses immediately; a claim balance must match the visible claim.
  refresh();
}
function renderComposer() {
  const eventButtons = Array.from({ length: 8 }, (_, index) => {
    const selected = legs.some(l => l.index === index);
    const button = el('button', String.fromCharCode(65 + index), 'event');
    button.type = 'button';
    button.setAttribute('aria-label', `Event ${String.fromCharCode(65 + index)}`);
    button.setAttribute('aria-pressed', String(selected));
    button.disabled = !selected && legs.length >= 3;
    button.addEventListener('click', () => {
      legs = selected ? legs.filter(l => l.index !== index) : [...legs, { index, yes: true }];
      legs.sort((a, b) => a.index - b.index);
      customMask = legs.length ? compileClaim(legs, 'all').mask : 0;
      changeClaim(true);
    });
    return button;
  });
  $('events').replaceChildren(...eventButtons);
  $('legs').replaceChildren(...legs.map(leg => {
    const row = el('div', undefined, 'leg');
    row.append(el('span', `Synthetic event ${String.fromCharCode(65 + leg.index)}`));
    const controls = el('div', undefined, 'leg-controls');
    const select = el('select');
    select.setAttribute('aria-label', `Outcome for event ${String.fromCharCode(65 + leg.index)}`);
    for (const [value, label] of [['yes', 'YES'], ['no', 'NO']]) {
      const option = el('option', label); option.value = value; select.append(option);
    }
    select.value = leg.yes ? 'yes' : 'no';
    select.disabled = $('mode').value === 'custom';
    select.addEventListener('change', () => { leg.yes = select.value === 'yes'; changeClaim(); });
    controls.append(select); row.append(controls); return row;
  }));
  const custom = $('mode').value === 'custom';
  $('truth-area').hidden = !custom;
  $('truth-table').replaceChildren();
  if (custom && legs.length) for (let state = 0; state < 1 << legs.length; state++) {
    const label = el('label');
    const check = el('input'); check.type = 'checkbox'; check.checked = Boolean(customMask & (1 << state));
    check.addEventListener('change', () => {
      customMask = check.checked ? customMask | (1 << state) : customMask & ~(1 << state);
      changeClaim();
    });
    label.append(check, el('span', legs.map((l, i) => `${String.fromCharCode(65 + l.index)} ${state & (1 << i) ? 'YES' : 'NO'}`).join(' · ')));
    $('truth-table').append(label);
  }
}

function tick() {
  const fresh = data && snapshotFresh(data.snapshot);
  const usable = fresh && data.trading_available && Date.now() / 1000 < data.cluster.closes_at;
  $('quote-button').disabled = !composed || !quantityValid || !usable || stateBusy || quoteBusy || Boolean(trading?.busy);
  $('quote-button').textContent = quoteBusy ? 'Reading the pool…' : options.consumer ? 'Check price' : 'Get pool quote ↗';
  $('refresh').disabled = stateBusy;
  $('refresh').textContent = stateBusy ? 'Reading…' : 'Refresh data ↻';
  $('status-dot').className = 'status-dot' + (lastFailure ? ' off' : fresh ? ' live' : '');
  text('connection', stateBusy ? 'Refreshing chain data…' : lastFailure ? 'Data unavailable' : !data ? 'Connecting to Monad…' : fresh ? 'Chain data is fresh' : 'Snapshot is stale');
  text('block-label', data ? `Block ${data.snapshot.block_number.toLocaleString()} · ${Math.max(0, Math.floor(Date.now() / 1000 - data.snapshot.timestamp))}s old` : '');
  $('notice').className = 'notice' + (fresh && !lastFailure ? ' good' : '');
  text('notice', lastFailure || (!data ? 'Loading the verified deployment. No wallet is connected.' : !fresh
    ? 'Showing the last snapshot. Quotes are disabled until fresh chain data arrives. Refresh when the network is available.'
    : !usable ? 'Pool quotes are unavailable: the market is closed, resolved, unfunded or has a backing shortfall.'
    : `${data.environment === 'local_fork' ? 'Local Monad fork' : 'Monad testnet'} · Synthetic events · Pool quotes are on-chain. Trades require your connected wallet's approval.`));
  // A quote is read at its own block. An older dashboard snapshot expiring
  // must not cancel a newer quote while wallet preflight is running.
  const marketStopped = fresh && data.snapshot.timestamp >= (quote?.snapshot.timestamp ?? 0) && !data.trading_available;
  if (quote && (!quoteReviewable(quote) || marketStopped || Date.now() / 1000 >= data?.cluster.closes_at)) {
    invalidateQuote('Quote expired or chain data became stale. Refresh and request a new quote.');
  } else if (quote) {
    const seconds = Math.max(0, Math.ceil(quote.quote.valid_until - Date.now() / 1000));
    text('quote-expiry', `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} to review`);
  }
  trading?.update();
}

function clearState() {
  data = null;
  for (const id of ['collateral', 'liability', 'coverage', 'phase', 'bid', 'ask']) text(id, 'Unavailable');
  text('surplus', 'Coverage surplus is not profit'); text('close', 'Close time unavailable');
  text('receipt-backing', 'Receipt backing unavailable'); text('network-name', 'Deployment unavailable');
  text('rules', 'Settlement rules unavailable'); text('resolution', '');
  $('contracts').replaceChildren(); $('wallet-result').replaceChildren();
}
function renderState() {
  const p = data.pool;
  text('collateral', formatUnits(p.pool_collateral_atoms));
  text('liability', formatUnits(p.required_collateral_atoms));
  text('coverage', p.covered ? 'Covered' : 'Shortfall');
  $('coverage').classList.toggle('danger', !p.covered);
  text('surplus', `${formatUnits(p.coverage_surplus_atoms)} AUSD surplus · not profit`);
  text('phase', p.phase[0].toUpperCase() + p.phase.slice(1));
  text('close', `Closes ${new Date(data.cluster.closes_at * 1000).toLocaleString()}`);
  text('bid', data.kuru.best_bid_wad === null ? 'No bids' : formatUnits(data.kuru.best_bid_wad, 18));
  text('ask', data.kuru.best_ask_wad === null ? 'No asks' : formatUnits(data.kuru.best_ask_wad, 18));
  text('receipt-backing', p.receipt_backed ? `${formatUnits(p.receipt_supply_atoms)} receipts · fully escrow-backed` : 'Receipt escrow mismatch Unavailable quoting disabled');
  text('network-name', `${data.environment === 'local_fork' ? 'Local Monad fork' : 'Monad testnet'} · ${data.chain_id}`);
  text('rules', data.cluster.rules);
  text('resolution', p.resolved ? `Resolved outcome bits: ${p.resolved_state}. Event A is bit 0; H is bit 7.` : 'Settlement is pending. These are synthetic fixtures with a trusted resolver.');
  $('contracts').replaceChildren();
  for (const [name, address] of Object.entries({ ...data.contracts, resolver: data.cluster.resolver, 'snapshot hash': data.snapshot.block_hash })) {
    $('contracts').append(el('dt', name), el('dd', address));
  }
  renderWallet(); tick(); options.onSnapshot?.(data);
}
function renderWallet() {
  const w = data?.wallet;
  $('wallet-result').replaceChildren();
  if (!wallet || !w || w.address.toLowerCase() !== wallet.toLowerCase()) return;
  text('wallet-message', `Inspecting ${w.address}. Balance lookup only; your connected signer is shown in Wallet & Execution above.`);
  const balances = el('div', undefined, 'balances');
  for (const [label, amount, decimals] of [
    ['AUSD balance', w.ausd_atoms, 6], ['Native MON', w.native_balance_wei, 18], ['Wrapped H YES receipts', w.receipt_atoms, 6],
    ['Available Kuru AUSD', w.margin_available_ausd_atoms, 6], ['Available Kuru receipts', w.margin_available_receipt_atoms, 6], ['Pool allowance (AUSD)', w.pool_allowance_atoms, 6],
  ]) {
    if (amount === null) continue; // This market has no receipt or Kuru integration.
    const cell = el('div'); cell.append(el('strong', formatUnits(amount, decimals)), el('span', label)); balances.append(cell);
  }
  const table = el('table', undefined, 'holdings');
  const head = el('thead'), header = el('tr'); header.append(el('th', 'Requested pool claim'), el('th', 'Units held'), el('th', 'Settlement'), el('th', 'Redeemable AUSD')); head.append(header);
  const body = el('tbody');
  for (const p of w.positions) {
    const row = el('tr'); row.append(el('td', selectedLabels.get(`${p.scope}:${p.mask}`) || `Scope ${p.scope} · mask ${p.mask}`), el('td', formatUnits(p.quantity_atoms)), el('td', p.settlement), el('td', p.redeemable_atoms === null ? 'Pending' : formatUnits(p.redeemable_atoms))); body.append(row);
  }
  table.append(head, body);
  $('wallet-result').append(balances, table, el('p', 'Only the eight base YES claims and your current composed claim are requested. This is not a complete portfolio.' + (marketId === 'learning' ? ' These holdings belong to the learning pool only.' : ' Kuru available balances exclude resting-order reserves; wrapped receipts are separate from internal pool holdings.'), 'caption'));
}
async function refresh() {
  if (disposed) return;
  const generation = ++stateGeneration;
  stateController?.abort(); stateController = new AbortController(); stateBusy = true;
  $('wallet-result').replaceChildren();
  if (wallet) text('wallet-message', 'Reading balances for the selected address…');
  const labels = new Map(Array.from({ length: 8 }, (_, i) => [`${1 << i}:2`, `${String.fromCharCode(65 + i)} YES`]));
  if (composed) labels.set(`${composed.scope}:${composed.mask}`, claimLabel(legs, $('mode').value));
  const query = new URLSearchParams();
  if (wallet) { query.set('wallet', wallet); query.set('claims', [...labels.keys()].join(',')); }
  tick();
  try {
    const result = await request(`/api/state${query.size ? '?' + query : ''}`, stateController);
    if (generation !== stateGeneration) return;
    // A newer block alone is not an input change. Execution rechecks price,
    // allowance and holdings against the reviewed limits before submission.
    const deploymentChanged = data && (data.environment !== result.environment || data.chain_id !== result.chain_id ||
      Object.entries(data.contracts).some(([key, value]) => value !== result.contracts[key]));
    if (deploymentChanged) invalidateQuote('The deployment changed. Request a fresh quote.');
    data = result; lastFailure = ''; selectedLabels = labels;
    renderState();
  } catch (error) {
    if (generation !== stateGeneration) return;
    clearState(); lastFailure = error.message; invalidateQuote('Live data is unavailable. Refresh before requesting a quote.');
    if (wallet) text('wallet-message', 'Balances unavailable. Retry with Refresh data.');
  } finally { if (generation === stateGeneration) { stateBusy = false; tick(); } }
}

async function requestQuote() {
  if (!composed || !data?.trading_available || !snapshotFresh(data.snapshot)) return;
  invalidateQuote('Reading the exact claim and quantity from the pool…');
  const generation = quoteGeneration;
  quoteController = new AbortController(); quoteBusy = true;
  const side = $('side').value, label = claimLabel(legs, $('mode').value);
  let quantity;
  try { quantity = parseUnits($('quantity').value.trim()); } catch (error) { quoteBusy = false; text('compose-error', error.message); tick(); return; }
  const params = new URLSearchParams({ side, scope: composed.scope, mask: composed.mask, quantity });
  tick();
  try {
    const result = await request('/api/quote?' + params, quoteController);
    if (generation !== quoteGeneration) return;
    if (!snapshotFresh(result.snapshot) || !quoteReviewable(result)) {
      emptyQuote(result.reason || 'A fresh quote is unavailable. Refresh the data and retry.'); return;
    }
    quote = result;
    const q = result.quote;
    const amount = el('p', formatUnits(q.collateral_atoms), 'quote-amount'); amount.append(el('span', ' AUSD'));
    const expiry = el('span'); expiry.id = 'quote-expiry';
    const detail = el('div', undefined, 'quote-detail'); detail.append(el('span', `Block ${result.snapshot.block_number.toLocaleString()}`), expiry);
    $('quote-result').replaceChildren(el('p', side === 'buy' ? 'Total buy cost' : 'Total sell proceeds', 'caption'), amount,
      el('p', `${formatUnits(q.quantity_atoms)} units · ${label}`, 'caption'), detail,
      el('p', 'Pool price for this quantity, not a probability. Gas is excluded. Ownership and allowance are not checked; execution must recheck price and slippage.', 'caption'));
    if (options.consumer && side === 'buy') $('quote-result').append(el('p', `Pays ${formatUnits(q.quantity_atoms)} AUSD if your prediction wins; pays 0 otherwise.`, 'caption'));
    return result;
  } catch (error) { if (generation === quoteGeneration) emptyQuote(error.message); }
  finally { if (generation === quoteGeneration) { quoteBusy = false; tick(); } }
}
$('quote-button').addEventListener('click', requestQuote);
$('mode').addEventListener('change', () => {
  if ($('mode').value === 'custom' && legs.length) customMask = compileClaim(legs, 'all').mask;
  changeClaim(true);
});
for (const id of ['quantity', 'side']) $(id).addEventListener('input', () => { invalidateQuote('Quote inputs changed. Request a new quote.'); preview(); });
$('refresh').addEventListener('click', () => { invalidateQuote('Refreshing the pool. Request a new quote when data is fresh.'); refresh(); });
$('wallet').addEventListener('input', () => {
  wallet = null; ++stateGeneration; stateController?.abort(); stateBusy = false;
  $('wallet-result').replaceChildren(); text('wallet-message', 'Address changed. Select View balances to load it.'); tick();
});
$('wallet-form').addEventListener('submit', event => {
  event.preventDefault();
  const value = $('wallet').value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) { text('wallet-message', 'Enter a valid 0x address with 40 hexadecimal characters.'); return; }
  wallet = value; refresh();
});
$('wallet-clear').addEventListener('click', () => { wallet = null; $('wallet').value = ''; text('wallet-message', 'No wallet selected.'); refresh(); });
$('tx-hash').addEventListener('input', () => {
  ++txGeneration; txController?.abort(); $('tx-button').disabled = false;
  text('tx-result', 'Hash changed. Select Check status to read this transaction.');
});
$('tx-form').addEventListener('submit', async event => {
  event.preventDefault(); const hash = $('tx-hash').value.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) { text('tx-result', 'Enter a 0x transaction hash with 64 hexadecimal characters.'); return; }
  const generation = ++txGeneration; txController?.abort(); txController = new AbortController();
  $('tx-button').disabled = true; text('tx-result', 'Reading transaction status…');
  try {
    const result = await request('/api/transaction?' + new URLSearchParams({ hash }), txController);
    if (generation !== txGeneration) return;
    const tx = result.transaction;
    const inclusion = tx.block_number ? ` · Block ${tx.block_number.toLocaleString()} · ${tx.confirmations} confirmation(s) · ${tx.gas_used} gas` : '';
    const target = tx.targets_demo === true ? 'Targets a configured demo contract.' : tx.targets_demo === false ? 'Does not target a configured demo contract.' : 'Target not yet known.';
    text('tx-result', `${tx.status.replaceAll('_', ' ')}${inclusion}. ${target} ${snapshotFresh(result.snapshot) ? '' : 'Chain snapshot is stale; refresh before relying on this status. '}Confirmations do not imply finality or prove a particular trade succeeded.`);
  } catch (error) { if (generation === txGeneration) text('tx-result', error.message); }
  finally { if (generation === txGeneration) $('tx-button').disabled = false; }
});

trading = mountTrading({
  marketId,
  onBusy: options.onBusy,
  root,
  consumer: Boolean(options.consumer),
  requestQuote: options.consumer ? requestQuote : undefined,
  canRequestQuote: () => Boolean(composed && quantityValid && data?.trading_available && snapshotFresh(data.snapshot) && Date.now() / 1000 < data.cluster.closes_at && !stateBusy && !quoteBusy),
  getSide: () => $('side').value,
  providers: options.providers || [],
  verifyWallet: options.verifyWallet,
  getState: () => data,
  getSelection: () => composed && quantityValid ? { ...composed, quantity: parseUnits($('quantity').value.trim()), label: claimLabel(legs, $('mode').value) } : null,
  readHealth: () => request('/api/health', new AbortController()),
  fundLocal: wallet => request('/api/local-wallet-setup', new AbortController(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ wallet }) }),
  getQuote: () => quote ? structuredClone(quote) : null,
  readSnapshot: (account, selected = composed || { scope: 128, mask: 2 }) => request('/api/state?' + new URLSearchParams({ wallet: account, claims: `${selected.scope}:${selected.mask}` }), new AbortController()),
  readTransaction: hash => request('/api/transaction?' + new URLSearchParams({ hash }), new AbortController()),
  invalidateQuote,
  refresh,
  accountChanged: account => {
    options.onWallet?.(account);
    invalidateQuote('Wallet changed. Request a fresh quote.');
    wallet = account; $('wallet').value = account || '';
    if (!account) text('wallet-message', 'No wallet selected.');
    refresh();
  },
});
if (wallet) $('wallet').value = wallet;
renderComposer(); preview(); refresh();
const tickTimer = setInterval(tick, 1000);
const refreshTimer = setInterval(() => { if (!document.hidden && !stateBusy && !quoteBusy && !trading.busy) refresh(); }, 15000);
const visible = () => {
  if (!document.hidden) {
    tick();
    if (!stateBusy && !quoteBusy && !trading.busy) refresh();
  }
};
document.addEventListener('visibilitychange', visible);
return () => {
  disposed = true; ++stateGeneration; ++quoteGeneration; ++txGeneration;
  stateController?.abort(); quoteController?.abort(); txController?.abort();
  clearInterval(tickTimer); clearInterval(refreshTimer);
  document.removeEventListener('visibilitychange', visible); trading.destroy();
};
}

if (document.querySelector('[data-standalone-dashboard]')) mountDashboard(document);
