// EIP-1193 requests stay in the user's selected wallet. The HTTP API never signs.
import { compileClaim, snapshotFresh, quoteReviewable, REVIEW_SECONDS } from './claims.mjs';

export const CHAIN_ID = '0x279f';
export const SELECTORS = { buy: '3e6b6cde', sell: 'c39849c5', approve: '095ea7b3', redeem: 'df992423', wrap: 'b0a52172', unwrap: 'f6c4eade', withdraw: 'a9059cbb' };
const conversion = kind => kind === 'wrap' || kind === 'unwrap';
export const supportedDeployment = state => state?.chain_id === 10143 && (state.environment === 'local_fork' || (state.environment === 'public_testnet' && state.contracts?.cash?.toLowerCase() === '0xa9012a055bd4e0edff8ce09f960291c09d5322dc'));
const MAX128 = (1n << 128n) - 1n;
export const address = value => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error('Invalid wallet or contract address.');
  return value.toLowerCase();
};
export const hex = value => '0x' + BigInt(value).toString(16);
const word = value => {
  const n = BigInt(value);
  if (n < 0n || n >= 1n << 256n) throw new Error('ABI value is outside uint256.');
  return n.toString(16).padStart(64, '0');
};
export const encode = (selector, ...args) => '0x' + selector + args.map(word).join('');
export class WalletError extends Error {}
export async function setupLocalWallet(provider, hooks) {
  const health = await hooks.readHealth();
  if (!health.local_wallet_setup) throw new WalletError('Automatic local setup is disabled. Start the local server with --enable-local-wallet-setup.');
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  if (!Array.isArray(accounts) || !accounts.length) throw new WalletError('Choose your dedicated test account in MetaMask.');
  const owner = address(accounts[0]);
  let state = await hooks.readSnapshot(owner);
  if (state.environment !== 'local_fork' || state.chain_id !== 10143 || !snapshotFresh(state.snapshot)) throw new WalletError('A fresh local demo is required before wallet setup.');
  let matches = false;
  try { await assertContext(provider, state, owner); matches = true; } catch { /* Request configuration only when it is needed. */ }
  if (!matches) {
    try {
      await provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: CHAIN_ID, chainName: 'Flurbo local fork',
        nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 }, rpcUrls: ['http://127.0.0.1:18545'] }] });
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_ID }] });
    } catch (error) {
      if (error?.code === 4001) throw error;
      throw new WalletError('MetaMask could not apply the local RPC automatically. Select http://127.0.0.1:18545 in its chain-10143 RPC settings, then retry setup.');
    }
    state = await hooks.readSnapshot(owner);
  }
  // Same chain ID is not enough; never fund an account before wallet/fork identity matches.
  await assertContext(provider, state, owner);
  await hooks.fundLocal(owner);
  state = await hooks.readSnapshot(owner);
  await assertContext(provider, state, owner);
  if (BigInt(state.wallet.ausd_atoms) < 10000000n || BigInt(state.wallet.native_balance_wei) < 10000000000000000000n) throw new WalletError('Local funding is not yet visible. Check balances before retrying.');
  return owner;
}
export function walletMessage(error) {
  if (error?.code === 4001) return 'You rejected the wallet request. Nothing was submitted by this request.';
  if (error?.code === -32002) return 'A request is already open in your wallet. Complete or reject it there.';
  if (error?.code === 4100) return 'The wallet has not authorized this account. Reconnect it.';
  if ([4900, 4901].includes(error?.code)) return 'The wallet is disconnected from the required Monad network.';
  return error instanceof WalletError ? error.message : 'Wallet request failed. Check the wallet and its RPC connection; remote details are withheld.';
}

export function boundFor(quote, bps) {
  if (!Number.isInteger(bps) || bps < 0 || bps > 500) throw new WalletError('Choose slippage from 0% to 5%.');
  const price = BigInt(quote.collateral_atoms), qty = BigInt(quote.quantity_atoms);
  if (price <= 0n || price > qty || qty > MAX128) throw new WalletError('Quote amounts are outside supported bounds.');
  if (quote.side === 'buy') {
    const upper = (price * BigInt(10000 + bps) + 9999n) / 10000n;
    return upper > qty ? qty : upper;
  }
  if (quote.side !== 'sell') throw new WalletError('Unsupported quote direction.');
  const lower = price * BigInt(10000 - bps) / 10000n;
  if (lower === 0n) throw new WalletError('The minimum proceeds would round to zero. Increase quantity or reduce slippage.');
  return lower;
}

export function makePlan(snapshot, quoted, account, bps, now = Date.now() / 1000) {
  account = address(account);
  if (!supportedDeployment(snapshot) || quoted.environment !== snapshot.environment || quoted.chain_id !== 10143 ||
      (snapshot.market_id || 'original') !== (quoted.market_id || 'original') ||
      quoted.contracts && (quoted.contracts.pool !== snapshot.contracts.pool || quoted.contracts.cash !== snapshot.contracts.cash)) {
    throw new WalletError('A verified Monad testnet deployment and matching quote are required.');
  }
  if (!snapshotFresh(snapshot.snapshot, now) || !quoteReviewable(quoted, now) || !snapshot.trading_available) {
    throw new WalletError('The quote or pool state expired. Refresh and request a new quote.');
  }
  const q = quoted.quote;
  const legs = Array.from({ length: 8 }, (_, index) => ({ index, yes: true })).filter(l => q.scope & (1 << l.index));
  const canonical = compileClaim(legs, 'custom', q.mask);
  if (canonical.scope !== q.scope) throw new WalletError('Unsupported claim scope.');
  const w = snapshot.wallet;
  if (!w || address(w.address) !== account) throw new WalletError('Load the connected wallet balances before reviewing.');
  const limit = boundFor(q, bps);
  const pool = address(snapshot.contracts.pool), cash = address(snapshot.contracts.cash);
  let kind = q.side, approval;
  if (kind === 'buy') {
    if (BigInt(w.ausd_atoms) < limit) throw new WalletError(snapshot.environment === 'local_fork' ? 'Not enough local test AUSD for this buy. Click Set up local wallet to top up test balances, then get a new quote.' : 'Not enough test AUSD. Fund this wallet on Monad testnet, then request a new quote.');
    if (BigInt(w.pool_allowance_atoms) < limit) {
      kind = 'approve';
      approval = BigInt(w.pool_allowance_atoms) > 0n ? 0n : limit;
    }
  } else {
    const holding = w.positions.find(p => p.scope === q.scope && p.mask === q.mask);
    if (!holding || BigInt(holding.quantity_atoms) < BigInt(q.quantity_atoms)) throw new WalletError('Not enough internal pool units to sell this claim. Wrapped receipts must be unwrapped separately.');
  }
  // Keep two minutes for the wallet prompt after the five-minute review window.
  // The reviewed slippage limit is fixed and simulated again before submission.
  const deadline = Math.min(q.valid_until + 120, snapshot.cluster.closes_at - 1);
  if (deadline <= now) throw new WalletError('The market is closing.');
  const input = kind === 'approve' ? encode(SELECTORS.approve, pool, approval)
    : encode(SELECTORS[kind], q.scope, q.mask, q.quantity_atoms, limit, deadline);
  return {
    kind, account, pool, cash, scope: q.scope, mask: q.mask, quantity: q.quantity_atoms,
    limit: limit.toString(), approval: approval?.toString(), deadline,
    quoteExpiry: q.valid_until, quoteSnapshot: quoted.snapshot, bps,
    tx: { from: account, to: kind === 'approve' ? cash : pool, data: input, value: '0x0', chainId: CHAIN_ID },
  };
}

export async function assertContext(provider, snapshot, account) {
  const accounts = await provider.request({ method: 'eth_accounts' });
  if (!Array.isArray(accounts) || !accounts.length || address(accounts[0]) !== address(account)) throw new WalletError('Wallet account changed. Reconnect and review again.');
  const chain = await provider.request({ method: 'eth_chainId' });
  if (BigInt(chain) !== 10143n) throw new WalletError(snapshot.environment === 'local_fork' ? 'Select the local Monad fork (chain 10143, RPC http://127.0.0.1:18545) in your wallet.' : 'Select Monad testnet (chain 10143) in your wallet.');
  if (!supportedDeployment(snapshot) || !snapshotFresh(snapshot.snapshot)) throw new WalletError('A fresh verified Monad deployment snapshot is required.');
  const block = await provider.request({ method: 'eth_getBlockByNumber', params: [hex(snapshot.snapshot.block_number), false] });
  if (!block || block.hash?.toLowerCase() !== snapshot.snapshot.block_hash.toLowerCase()) {
    throw new WalletError(snapshot.environment === 'local_fork' ? 'Wallet RPC does not match this local fork. Public Monad testnet has the same chain ID; choose RPC http://127.0.0.1:18545 manually.' : 'Wallet RPC does not match public Monad testnet. Select https://testnet-rpc.monad.xyz manually, then reconnect.');
  }
}

export async function simulate(provider, plan) {
  const output = await provider.request({ method: 'eth_call', params: [plan.tx, 'latest'] });
  if (conversion(plan.kind)) {
    if (output !== '0x') throw new WalletError('Unexpected receipt conversion simulation result.');
    return;
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(output)) throw new WalletError('Unexpected contract simulation result.');
  const amount = BigInt(output);
  if (plan.kind === 'redeem' ? amount !== BigInt(plan.payout) : ['approve', 'withdraw'].includes(plan.kind) ? amount !== 1n : plan.kind === 'buy' ? amount > BigInt(plan.limit) : amount < BigInt(plan.limit)) {
    throw new WalletError('Simulation did not satisfy the reviewed approval, price limit or redemption payout.');
  }
}

export async function prepare(provider, snapshot, quoted, account, bps) {
  const plan = makePlan(snapshot, quoted, account, bps);
  return preparePlan(provider, snapshot, plan);
}

export function makeRedemptionPlan(snapshot, selected, account, quantity) {
  account = address(account);
  if (!supportedDeployment(snapshot) || !snapshotFresh(snapshot.snapshot) ||
      !snapshot.redemption_available || !snapshot.pool?.resolved || !snapshot.pool.covered || !snapshot.pool.receipt_backed) {
    throw new WalletError('Redemption requires a fresh, resolved and fully backed Monad pool.');
  }
  const outcome = snapshot.pool.resolved_state;
  if (!Number.isInteger(outcome) || outcome < 0 || outcome > 255) throw new WalletError('Invalid settlement outcome.');
  const { scope, mask } = selected;
  if (!Number.isInteger(scope) || scope < 1 || scope > 255) throw new WalletError('Invalid claim scope.');
  const legs = Array.from({ length: 8 }, (_, index) => ({ index, yes: true })).filter(l => scope & (1 << l.index));
  const canonical = compileClaim(legs, 'custom', mask);
  if (canonical.scope !== scope || canonical.mask !== mask) throw new WalletError('Unsupported redemption claim.');
  const qty = BigInt(quantity);
  const w = snapshot.wallet;
  const holding = w?.positions.find(p => p.scope === scope && p.mask === mask);
  if (!w || address(w.address) !== account || qty <= 0n || qty > MAX128 || !holding || BigInt(holding.quantity_atoms) < qty) {
    throw new WalletError('Choose a positive quantity within your connected wallet’s internal claim holdings. Wrapped receipts must be unwrapped separately.');
  }
  const projected = legs.reduce((value, leg, i) => value | (((outcome >> leg.index) & 1) << i), 0);
  const payout = mask & (1 << projected) ? qty : 0n;
  const pool = address(snapshot.contracts.pool), cash = address(snapshot.contracts.cash);
  return { kind: 'redeem', account, pool, cash, scope, mask, quantity: qty.toString(), payout: payout.toString(), outcome,
    quoteExpiry: snapshot.snapshot.timestamp + REVIEW_SECONDS,
    tx: { from: account, to: pool, data: encode(SELECTORS.redeem, scope, mask, qty), value: '0x0', chainId: CHAIN_ID } };
}

export async function prepareRedemption(provider, snapshot, selected, account, quantity) {
  return preparePlan(provider, snapshot, makeRedemptionPlan(snapshot, selected, account, quantity));
}

export function makeConversionPlan(snapshot, kind, account, quantity) {
  account = address(account);
  if (!conversion(kind) || !supportedDeployment(snapshot) ||
      !snapshotFresh(snapshot.snapshot) || !snapshot.conversion_available || !snapshot.pool?.receipt_backed) {
    throw new WalletError('Conversion requires a fresh verified snapshot and fully backed canonical H YES receipts.');
  }
  const qty = BigInt(quantity), w = snapshot.wallet;
  if (!w || address(w.address) !== account || qty <= 0n || qty > MAX128) throw new WalletError('Choose a positive conversion quantity for the connected wallet.');
  const available = kind === 'wrap' ? w.positions.find(p => p.scope === 128 && p.mask === 2)?.quantity_atoms : w.receipt_atoms;
  if (available === undefined || BigInt(available) < qty) throw new WalletError(kind === 'wrap'
    ? 'Not enough internal H YES units. Buy H YES first; composed claims cannot be wrapped here.'
    : 'Not enough H YES receipts in your wallet. Receipts deposited in Kuru must be withdrawn first.');
  const pool = address(snapshot.contracts.pool), cash = address(snapshot.contracts.cash), receipt = address(snapshot.contracts.receipt);
  return { kind, account, pool, cash, receipt, scope: 128, mask: 2, quantity: qty.toString(), quoteExpiry: snapshot.snapshot.timestamp + REVIEW_SECONDS,
    tx: { from: account, to: pool, data: encode(SELECTORS[kind], 7, 1, qty), value: '0x0', chainId: CHAIN_ID } };
}

export async function prepareConversion(provider, snapshot, kind, account, quantity) {
  return preparePlan(provider, snapshot, makeConversionPlan(snapshot, kind, account, quantity));
}

export function makeWithdrawalPlan(snapshot, account, recipient, quantity) {
  account = address(account); recipient = address(recipient);
  if (!supportedDeployment(snapshot) || !snapshotFresh(snapshot.snapshot)) throw new WalletError('A fresh Monad snapshot is required for withdrawal.');
  const pool = address(snapshot.contracts.pool), cash = address(snapshot.contracts.cash), qty = BigInt(quantity);
  if (['0x' + '0'.repeat(40), account, pool, cash].includes(recipient)) throw new WalletError('Choose a different receiving wallet, not a pool or token contract.');
  if (!snapshot.wallet || address(snapshot.wallet.address) !== account || qty <= 0n || qty > MAX128 || BigInt(snapshot.wallet.ausd_atoms) < qty) {
    throw new WalletError('Withdraw only available AUSD in the selected wallet. Sell or redeem positions first; Kuru deposits are separate.');
  }
  return { kind: 'withdraw', account, recipient, pool, cash, quantity: qty.toString(), quoteExpiry: snapshot.snapshot.timestamp + REVIEW_SECONDS,
    tx: { from: account, to: cash, data: encode(SELECTORS.withdraw, recipient, qty), value: '0x0', chainId: CHAIN_ID } };
}

export async function prepareWithdrawal(provider, snapshot, account, recipient, quantity) {
  return preparePlan(provider, snapshot, makeWithdrawalPlan(snapshot, account, recipient, quantity));
}

async function preparePlan(provider, snapshot, plan) {
  await assertContext(provider, snapshot, plan.account);
  await simulate(provider, plan);
  const estimate = BigInt(await provider.request({ method: 'eth_estimateGas', params: [plan.tx] }));
  const gas = (estimate * 120n + 99n) / 100n;
  const gasPrice = BigInt(await provider.request({ method: 'eth_gasPrice' })) * 2n;
  if (gas <= 0n || gas > 30000000n || gasPrice <= 0n) throw new WalletError('Gas estimate is outside the supported limits.');
  if (BigInt(snapshot.wallet.native_balance_wei) < gas * gasPrice) throw new WalletError('Not enough MON for the reviewed gas budget.');
  plan.tx.gas = hex(gas); plan.tx.gasPrice = hex(gasPrice);
  plan.gasBudget = (gas * gasPrice).toString();
  if (Date.now() / 1000 >= plan.quoteExpiry) throw new WalletError(['redeem', 'withdraw'].includes(plan.kind) || conversion(plan.kind) ? 'Snapshot expired during review. Refresh and review again.' : 'Quote expired during review. Request a new quote.');
  return plan;
}

export async function sendReviewed(provider, plan, snapshot, stillCurrent = () => true, onSubmit = () => {}) {
  const guard = () => {
    if (!stillCurrent()) throw new WalletError('Inputs or wallet changed. Review again.');
    if (Date.now() / 1000 >= plan.quoteExpiry) throw new WalletError('Review expired. Refresh and review again.');
    if (plan.kind === 'withdraw') {
      const checked = makeWithdrawalPlan(snapshot, plan.account, plan.recipient, plan.quantity);
      if (checked.tx.data !== plan.tx.data || plan.tx.to !== checked.cash) throw new WalletError('Withdrawal changed. Review again.');
    } else if (plan.kind === 'redeem') {
      const checked = makeRedemptionPlan(snapshot, plan, plan.account, plan.quantity);
      if (checked.outcome !== plan.outcome || checked.payout !== plan.payout || checked.tx.data !== plan.tx.data) throw new WalletError('Settlement changed. Review redemption again.');
    } else if (conversion(plan.kind)) {
      const checked = makeConversionPlan(snapshot, plan.kind, plan.account, plan.quantity);
      if (checked.receipt !== plan.receipt || checked.tx.data !== plan.tx.data) throw new WalletError('Receipt or conversion changed. Review again.');
    } else if (!snapshot.trading_available) throw new WalletError('Pool is not available for trading.');
    if (address(snapshot.contracts.pool) !== plan.pool || address(snapshot.contracts.cash) !== plan.cash) throw new WalletError('Deployment changed. Review again.');
  };
  guard(); await assertContext(provider, snapshot, plan.account); guard();
  // Repeat simulation immediately before opening the wallet; bounds and deadline stay unchanged.
  await simulate(provider, plan);
  await assertContext(provider, snapshot, plan.account); guard();
  onSubmit();
  return provider.request({ method: 'eth_sendTransaction', params: [{ ...plan.tx }] });
}

export function reconcile(plan, tx) {
  if (!['succeeded', 'reverted'].includes(tx.status)) return 'pending';
  if (tx.sender !== plan.account || tx.to !== plan.tx.to || tx.input !== plan.tx.data || tx.value_wei !== '0') return 'mismatch';
  if (tx.status === 'reverted') return 'reverted';
  const matches = (tx.events || []).filter(event => plan.kind === 'withdraw'
    ? event.kind === 'transfer' && event.owner === plan.account && event.recipient === plan.recipient && event.amount_atoms === plan.quantity
    : plan.kind === 'approve'
    ? event.kind === 'approval' && event.owner === plan.account && event.spender === plan.pool && event.amount_atoms === plan.approval
    : plan.kind === 'redeem' ? event.kind === 'redemption' && event.owner === plan.account && event.scope === plan.scope && event.mask === String(plan.mask) && event.quantity_atoms === plan.quantity && event.collateral_atoms === plan.payout
    : conversion(plan.kind) ? event.kind === plan.kind && event.owner === plan.account && event.scope === 128 && event.mask === '2' && event.quantity_atoms === plan.quantity
    : event.kind === 'trade' && event.trader === plan.account && event.scope === plan.scope && event.mask === String(plan.mask) && event.is_buy === (plan.kind === 'buy') && event.quantity_atoms === plan.quantity &&
      (plan.kind === 'buy' ? BigInt(event.collateral_atoms) <= BigInt(plan.limit) : BigInt(event.collateral_atoms) >= BigInt(plan.limit)));
  return matches.length === 1 ? 'matched' : 'mismatch';
}
