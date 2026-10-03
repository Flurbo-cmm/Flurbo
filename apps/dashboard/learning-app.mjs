import { isMetaMask } from './metamask.mjs';
import { context, receiptMatches, submit, validatePlan } from './learning-wallet.mjs';
const $ = id => document.getElementById(id);
const provider = isMetaMask(window.ethereum) ? window.ethereum : undefined;
let state, owner, plan, busy = false;
const amount = value => {
  const n = BigInt(value); return `${n / 1000000n}.${(n % 1000000n).toString().padStart(6, '0')}`;
};
const message = text => { $('message').textContent = text; };
async function api(path, data) {
  const response = await fetch(path, data ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {});
  const result = await response.json(); if (!response.ok) throw Error(result.error || 'Local data unavailable'); return result;
}
function controls() {
  $('setup').disabled = busy || !provider;
  $('refresh').disabled = busy;
  for (const kind of ['buy', 'sell', 'learn']) $(kind).disabled = busy || !owner || state?.owner !== owner;
  $('confirm').disabled = busy || !plan;
}
function invalidate() { plan = null; $('confirm').disabled = true; $('review-expiry').textContent = 'Get a new review before confirming.'; }
async function refresh() {
  state = await api('/api/state');
  $('connection').textContent = state.pool ? `Local chain ${state.chainId} · revision ${state.snapshot.revision}` : `Local chain ${state.chainId} · ready for setup`;
  $('model-source').textContent = state.modelSource;
  if (state.pool) {
    $('cash').textContent = amount(state.poolBalanceAtoms); $('reserve').textContent = amount(state.reserveAtoms);
    $('payout').textContent = amount(state.payoutAtoms);
    $('coverage').textContent = BigInt(state.poolBalanceAtoms) >= BigInt(state.reserveAtoms) ? 'Covered' : 'Shortfall';
    $('owner').textContent = `Lab account: ${state.owner}`;
    $('balances').textContent = `${amount(state.balanceAtoms)} mock tokens · ${amount(state.holdingsAtoms)} A AND B units`;
  }
  controls(); return state;
}
async function action(work) {
  if (busy) return;
  busy = true; controls();
  try { await work(); } catch (error) {
    invalidate(); message(error?.code === 4001 ? 'Wallet request rejected. No automatic retry.' : (error?.message || 'Action unavailable. Refresh before retrying.'));
  } finally { busy = false; controls(); }
}
$('setup').onclick = () => action(async () => {
  invalidate(); message('Choose your dedicated test account in MetaMask…');
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  if (!accounts?.length) throw Error('Choose a test account');
  owner = accounts[0].toLowerCase();
  await refresh();
  if (state.owner && owner !== state.owner) throw Error('Select the account already assigned to this lab');
  if (BigInt(await provider.request({ method: 'eth_chainId' })) !== 31339n) {
    await provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: '0x7a6b', chainName: 'Flurbo learning lab',
      nativeCurrency: { name: 'Local test gas', symbol: 'TEST', decimals: 18 }, rpcUrls: ['http://127.0.0.1:18548'] }] });
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x7a6b' }] });
  }
  await context(provider, state, owner);
  message('Preparing your local pool and mock balances…');
  state = await api('/api/setup', { wallet: owner }); await refresh();
  message('Test account ready. Start with Review buy.');
});
for (const kind of ['buy', 'sell', 'learn']) $(kind).onclick = () => action(async () => {
  invalidate(); await refresh(); await context(provider, state, owner);
  const candidate = await api(`/api/prepare?kind=${kind}`); validatePlan(candidate); plan = candidate;
  const approval = plan.action === 'approve';
  $('review-title').textContent = approval ? 'Approve a bounded amount.' : kind === 'learn' ? 'Apply the learned price.' : `${kind === 'buy' ? 'Buy' : 'Sell'} one A AND B unit.`;
  $('review-copy').textContent = approval ? 'This step only approves mock-token spending. After confirmation, review the action again.'
    : kind === 'learn' ? 'The model changes prices across the shared pool. Your existing holdings and payout rules stay the same.' : 'Review the quoted amount and your slippage limit before signing.';
  const rows = [['Action', plan.action], [kind === 'sell' ? 'Minimum proceeds' : 'Maximum spending', `${amount(plan.limitAtoms)} mock tokens`]];
  if (kind === 'learn') rows.push(['A AND B marginal before → after', `${(Number(plan.details.probabilityBefore) * 100).toFixed(4)}% → ${(Number(plan.details.probabilityAfter) * 100).toFixed(4)}%`],
    ['Extra funding needed', `${amount(plan.details.fundingAtoms)} mock tokens`], ['Quantization error upper bound', plan.details.quantizationBound]);
  $('review-details').replaceChildren(...rows.flatMap(([label, value]) => {
    const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; return [dt, dd];
  }));
  $('review-expiry').textContent = `Expires at ${new Date(Number(plan.deadline) * 1000).toLocaleTimeString()}. Any intervening trade/update requires a new review.`;
  $('technical').textContent = JSON.stringify({ pool: plan.pool, revision: plan.snapshot.revision, ...plan.details, proposal: plan.proposal }, null, 2);
  message(approval ? 'Review the bounded approval, then confirm in MetaMask.' : 'Review ready. Nothing has been sent.');
});
$('confirm').onclick = () => action(async () => {
  const reviewed = plan; plan = null;
  const hash = await submit(provider, reviewed, state);
  $('transaction').textContent = `Submitted ${hash}`; message('Waiting for the transaction and two canonical blocks…');
  for (let i = 0; i < 90; i++) {
    const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] });
    if (receipt?.status === '0x0') throw Error('Transaction reverted. Get a fresh review.');
    if (receipt) {
      const tx = await provider.request({ method: 'eth_getTransactionByHash', params: [hash] });
      const block = await provider.request({ method: 'eth_getBlockByNumber', params: [receipt.blockNumber, false] });
      const head = await provider.request({ method: 'eth_blockNumber' });
      if (receiptMatches(reviewed, tx, receipt, block, head)) {
        await refresh(); invalidate();
        message(reviewed.action === 'approve' ? 'Approval confirmed. Review the action again for its separate transaction.' : 'Confirmed: transaction, event and canonical blocks match. Balances refreshed.');
        return;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw Error(`Confirmation remains unverified. Inspect transaction ${hash} before retrying.`);
});
$('refresh').onclick = () => action(async () => { invalidate(); await refresh(); message('Data refreshed. Choose an action for a new review.'); });
provider?.on?.('accountsChanged', () => { owner = null; invalidate(); controls(); message('Account changed. Reconnect your test account.'); });
provider?.on?.('chainChanged', () => { invalidate(); message('Network changed. Verify the learning-lab network before reviewing.'); });
setInterval(() => { if (plan && Number(plan.deadline) <= Date.now() / 1000) { invalidate(); message('Review expired. Request a new one.'); } }, 1000);
refresh().catch(error => message(error.message));
controls();
