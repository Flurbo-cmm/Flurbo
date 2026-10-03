import { formatUnits } from 'viem';
import * as learning from '../../web/src/learning/execution';
import { rpcInteger, type Provider } from '../../web/src/pilot';
import { auth, storage } from './runtime';
import { api } from './api';
import { externalWallet, legacyProvider, tradingProvider, type WalletKind } from './wallet';
import { lockOperation } from './operation-lock';
import { sendReviewed } from '../../dashboard/wallet.mjs';

import { submitTracked, checkTracked } from './tracked-call';
import type { TrackedCall as Simple } from './tracked-call';
type Pending = { category: 'learning'; value: learning.Pending } | { category: 'transfer'; value: Simple };
const key = 'flurbo.mobile.operation.v1';
let state: { busy: boolean; pending: Pending | null; notice: string; revision: number } = { busy: false, pending: null, notice: '', revision: 0 };
const listeners = new Set<() => void>();
function update(patch: Partial<typeof state>) { state = { ...state, ...patch, revision: state.revision + 1 }; listeners.forEach(f => f()); }
function save(p: Pending | null) { if (p) storage.setItem(key, JSON.stringify(p)); else storage.removeItem(key); update({ pending: p }); }
const hex = (v: bigint) => '0x' + v.toString(16);
export const operations = {
  getSnapshot: () => state,
  subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  restore() { const raw = storage.getItem(key); if (raw) { const p = JSON.parse(raw) as Pending; if (!p || !['learning', 'transfer'].includes(p.category) || !p.value || (p.value.hash !== null && !/^0x[0-9a-f]{64}$/i.test(p.value.hash))) throw new Error('Saved transaction tracking is invalid. Check wallet activity before trading.'); update({ pending: p, notice: 'An earlier transaction needs checking.' }); } },
  async run(kind: WalletKind, action: (provider: ReturnType<typeof legacyProvider>, current: () => boolean) => Promise<void>, market: 'original' | 'learning' = 'original') {
    if (kind !== 'metamask') { update({notice:'Use MetaMask for transactions.'}); return; }
    let release: () => void;
    try { release = lockOperation(); } catch (e) { update({ notice: (e as Error).message }); return; }
    const login = auth.getSnapshot().address, owner = externalWallet.getSnapshot().address;
    const p = legacyProvider(kind, market);
    update({ busy: true, notice: 'Checking the reviewed transaction...' });
    try {
      if (!login || !owner) throw new Error('Sign in and connect the trading wallet first.');
      auth.checkExpiry();
      await action(p, () => auth.getSnapshot().address === login && externalWallet.getSnapshot().address === owner);
      await storage.flush(); update({ notice: 'Submitted. Check confirmation before another action.' });
    } catch (e) { update({ notice: e instanceof Error ? e.message : 'Check wallet activity before retrying.' }); }
    finally { p.destroy(); release(); update({ busy: false }); }
  },
  async learning(review: learning.Review, reviewed: () => boolean) {
    await this.run('metamask', async (p, current) => { await learning.submitLearning(p, review, {
      current: () => current() && reviewed(), save: value => save(value ? { category: 'learning', value } : null), authorize: async () => {
        const status = await api<{ operator: boolean; open: boolean; modelReady: boolean }>('/api/learning/pool');
        if (!status.operator || !status.open || !status.modelReady) throw new Error('Operator access or a fresh model is unavailable.');
      },
    }); });
  },
  async legacy(plan: any, snapshot: any, kind: WalletKind, market: 'original' | 'learning', reviewed: () => boolean) {
    await this.run(kind, async (provider, current) => {
      const wrapped: Provider = { async request(input) {
        if (input.method !== 'eth_sendTransaction') return provider.request(input);
        return sendTracked(provider, input.params![0] as Record<string, string>, () => current() && reviewed());
      } };
      await sendReviewed(wrapped, plan, snapshot, () => current() && reviewed());
    }, market);
  },
  async faucet(kind: WalletKind, review: FaucetReview, reviewed: () => boolean) {
    await this.run(kind, async (p, current) => {
      if (Date.now() > review.expires || review.tx.to !== '0xd236c18d274e54faccc3dd9dda4b27965a73ee6c' || review.tx.data !== '0x544c7cf9' + review.tx.from.slice(2).toLowerCase().padStart(64, '0') || review.tx.value !== '0x0' || review.tx.chainId !== '0x279f') throw new Error('Faucet review expired or changed.');
      const anchor = await p.request({ method: 'eth_getBlockByNumber', params: [review.block.number, false] }) as { hash: string };
      if (anchor?.hash !== review.block.hash) throw new Error('Chain snapshot changed.');
      await p.request({ method: 'eth_call', params: [review.tx, 'latest'] });
      if (rpcInteger(await p.request({ method: 'eth_estimateGas', params: [review.tx] })) > BigInt(review.tx.gas) || rpcInteger(await p.request({ method: 'eth_gasPrice' })) > BigInt(review.tx.gasPrice)) throw new Error('Network fees changed. Review again.');
      await sendTracked(p, review.tx, () => current() && reviewed());
    });
  },
  async attachHash(hash: string) { if (!state.pending || state.busy || !/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error('Enter the transaction hash from wallet activity.'); save({ ...state.pending, value: { ...state.pending.value, hash: hash.toLowerCase() } } as Pending); await storage.flush(); await this.check(); },
  async check() {
    if (!state.pending || state.busy) return;
    update({ busy: true });
    try {
      // Checking a receipt is read-only and does not require the signing wallet.
      const pending = state.pending;
      const p: Provider = { async request(input) {
        if (input.method === 'eth_blockNumber') return (await api<{ result: { number: string } }>('/api/pilot/rpc', { method: 'eth_getBlockByNumber', params: ['latest', false] })).result.number;
        return (await api<{ result: unknown }>('/api/pilot/rpc', { method: input.method, params: input.params ?? [] })).result;
      } };
      if (!pending.value.hash) throw new Error('Attach the transaction hash from wallet activity. Do not repeat the action.');
      const result = pending.category === 'learning' ? await learning.checkLearningReceipt(p, pending.value) : await checkTracked(p, pending.value);
      if (['confirmed', 'matched', 'reverted', 'succeeded'].includes(result)) { save(null); await storage.flush(); update({ notice: result === 'reverted' ? 'Transaction reverted. No successful action was confirmed.' : 'Transaction confirmed. Refresh balances or prepare the next action.' }); }
      else update({ notice: 'Waiting for confirmation. Do not repeat this transaction.' });
    } catch (e) { update({ notice: e instanceof Error ? e.message : 'Status unavailable. Try again shortly.' }); }
    finally { update({ busy: false }); }
  },
};
async function sendTracked(p: Provider, tx: Record<string, string>, current: () => boolean) {
  return submitTracked(p, tx, current, value => save(value ? { category: 'transfer', value } : null), storage.flush);
}
export type FaucetReview = { tx: Record<string, string>; block: { number: string; hash: string }; expires: number; fee: string };
export async function prepareFaucet(kind: WalletKind, owner: string): Promise<FaucetReview> {
  const p = legacyProvider(kind);
  try {
    if (rpcInteger(await p.request({ method: 'eth_chainId' })) !== 10143n) throw new Error('Select Monad testnet.');
    const block = await p.request({ method: 'eth_getBlockByNumber', params: ['latest', false] }) as { number: string; hash: string; timestamp: string };
    if (!block?.hash || Date.now() / 1000 - Number(rpcInteger(block.timestamp)) > 180) throw new Error('Chain data is stale.');
    const tx = { from: owner, to: '0xd236c18d274e54faccc3dd9dda4b27965a73ee6c', data: '0x544c7cf9' + owner.slice(2).toLowerCase().padStart(64, '0'), value: '0x0', chainId: '0x279f', gas: '', gasPrice: '' };
    const { gas: _, gasPrice: __, ...call } = tx;
    await p.request({ method: 'eth_call', params: [call, 'latest'] });
    const gas = rpcInteger(await p.request({ method: 'eth_estimateGas', params: [call] })) * 120n / 100n, price = rpcInteger(await p.request({ method: 'eth_gasPrice' })) * 2n;
    if (gas <= 0n || gas > 1_000_000n || price <= 0n || price > 500_000_000_000n) throw new Error('Faucet network fee exceeds testnet limits.');
    if (rpcInteger(await p.request({ method: 'eth_getBalance', params: [owner, 'latest'] })) < gas * price) throw new Error('Get test MON first to pay network fees.');
    tx.gas = hex(gas); tx.gasPrice = hex(price);
    return { tx, block, expires: Date.now() + 300_000, fee: formatUnits(gas * price, 18) };
  } finally { p.destroy(); }
}
