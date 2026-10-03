import {linkTradingWallet,linkedWallets} from '../../web/src/wallet-links';
import SignClient from '@walletconnect/sign-client';
import { Linking } from 'react-native';
import { api } from './api';
import { auth, storage } from './runtime';
import { CHAIN, REOWN_PROJECT_ID, sessionAddress, checkWalletTransaction } from './wallet-policy';
import { type Provider, type PilotNamespace } from '../../web/src/pilot';

type Snapshot = { address: string | null; busy: boolean; error: string | null; revision: number };
let snapshot: Snapshot = { address: null, busy: false, error: null, revision: 0 };
const listeners = new Set<() => void>();
let client: Awaited<ReturnType<typeof SignClient.init>> | undefined;
let topic: string | undefined;
let initialization: Promise<void> | undefined;
const update = (patch: Partial<Snapshot>) => { snapshot = { ...snapshot, ...patch, revision: snapshot.revision + 1 }; listeners.forEach(fn => fn()); };
export const externalWallet = {
  getSnapshot: () => snapshot,
  subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  async initialize() {
    if (initialization) return initialization;
    initialization = (async () => {
      client = await SignClient.init({ projectId: REOWN_PROJECT_ID, metadata: {
        name: 'Flurbo', description: 'Individual and combined predictions on Monad testnet',
        url: 'https://flurbo.singu.online', icons: [], redirect: { native: 'flurbo://' },
      } });
      const restore = () => {
        const sessions = client!.session.getAll().filter(s => s.expiry * 1000 > Date.now());
        const session = topic ? sessions.find(s => s.topic === topic) : sessions.at(-1);
        try { const address = session && sessionAddress(session); topic = address ? session!.topic : undefined; update({ address: address || null }); }
        catch { topic = undefined; update({ address: null }); }
      };
      client.on('session_update', restore);
      client.on('session_delete', restore);
      client.on('session_expire', restore);
      client.on('session_event', ({ topic: changed }) => {
        if (changed === topic) { topic = undefined; update({ address: null, error: 'Wallet account or network changed. Reconnect before trading.' }); }
      });
      restore();
    })().catch(() => { initialization = undefined; update({ error: 'MetaMask connection is unavailable. Try again shortly.' }); });
    return initialization;
  },
  async connect() {
    if (!auth.getSnapshot().address) throw new Error('Sign in with Mera first.');
    if (snapshot.busy) return;
    update({ busy: true, error: null });
    try {
      await this.initialize();
      if (!client) throw new Error('Wallet connection is unavailable.');
      const login = auth.getSnapshot().address;
      // Reuse the existing WalletConnect session when the wallet is paired
      // but linking failed on a previous attempt (mobile deep-link bounce).
      let session;
      if (topic) { try { const s = client.session.get(topic); sessionAddress(s); session = s; } catch { /* stale, re-pair */ } }
      if (!session) {
        const { uri, approval } = await client.connect({ requiredNamespaces: {
          eip155: { chains: [CHAIN], methods: ['eth_sendTransaction','personal_sign'], events: ['chainChanged', 'accountsChanged'] },
        } });
        const approved = approval();
        void approved.catch(() => undefined);
        if (uri) await Linking.openURL(`https://metamask.app.link/wc?uri=${encodeURIComponent(uri)}`);
        session = await approved;
      }
      if (auth.getSnapshot().address !== login) { await client.disconnect({ topic: session.topic, reason: { code: 6000, message: 'Flurbo login changed' } }); return; }
      const address = sessionAddress(session);
      // Commit the connection before attempting the linking signature so the
      // user sees their wallet even when the second MetaMask handoff drops.
      topic = session.topic; update({ address });
      try {
        await linkTradingWallet({request:async input=>{
          if(input.method==='eth_accounts')return [sessionAddress(client!.session.get(session.topic))];
          if(input.method!=='personal_sign')throw Error('Unsupported account-link request');
          const response=client!.request({topic:session.topic,chainId:CHAIN,request:{method:input.method,params:input.params??[]}});
          void response.catch(()=>undefined);void Linking.openURL('https://metamask.app.link/').catch(()=>undefined);return response;
        }},login!,address,()=>auth.getSnapshot().address===login);
      } catch {
        update({ error: 'Connected, but wallet linking needs one more signature. Tap Connect MetaMask to finish.' });
      }
    } catch (e: any) { topic = undefined; update({ address: null, error: `MetaMask connection did not finish. Open MetaMask, select Monad testnet, then reconnect.${e?.message ? ` (${e.message})` : ''}` }); }
    finally { update({ busy: false }); }
  },
  async disconnect() {
    const old = topic; topic = undefined; update({ address: null });
    if (client && old) await client.disconnect({ topic: old, reason: { code: 6000, message: 'Disconnected by user' } });
  },
};
export type WalletKind = 'metamask';
export function legacyProvider(kind: WalletKind, market: 'original' | 'learning' = 'original'): Provider & { destroy(): void } {
  return { ...tradingProvider(kind, 'pilot'), destroy() {} };
}
export function tradingProvider(kind: WalletKind, namespace: PilotNamespace): Provider {
  const login = auth.getSnapshot().address;
  const selected = snapshot.address, connection = topic;
  if (kind !== 'metamask') throw new Error('Use MetaMask for transactions. Mera is account-only.');
  return { async request(input) {
    if (auth.getSnapshot().address !== login || !login) throw new Error('Flurbo account changed. Sign in and review again.');
    if (!selected || connection !== topic || snapshot.address !== selected || !client || !topic) throw new Error('Reconnect MetaMask and review again.');
    const current = sessionAddress(client.session.get(topic));
    if (current !== selected) throw new Error('MetaMask account changed.');
    if (input.method === 'eth_accounts' || input.method === 'eth_requestAccounts') return [selected];
    if (input.method === 'eth_chainId') return '0x279f';
    if (input.method === 'eth_sendTransaction') {
      const links=await linkedWallets();
      if(links.account!==login||!links.wallets.includes(selected))throw Error('Connect MetaMask once to link it to this Flurbo account.');
      checkWalletTransaction(input.params?.[0], selected);
      await storage.flush();
      if (auth.getSnapshot().address !== login || topic !== connection || snapshot.address !== selected) throw new Error('Account changed before opening MetaMask. Review again.');
      const response = client.request({ topic, chainId: CHAIN, request: { method: input.method, params: input.params ?? [] } });
      void response.catch(() => undefined);
      // A failed foreground request does not mean the wallet rejected the transaction.
      void Linking.openURL('https://metamask.app.link/').catch(() => undefined);
      return response;
    }
    const methods = ['eth_getBlockByNumber', 'eth_getCode', 'eth_gasPrice', 'eth_getBalance', 'eth_getTransactionCount', 'eth_estimateGas', 'eth_call', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_blockNumber'];
    if (!methods.includes(input.method)) throw new Error('Unsupported wallet request.');
    if (input.method === 'eth_blockNumber') {
      const response = await api<{ result: { number: string } }>(`/api/${namespace}/rpc`, { method: 'eth_getBlockByNumber', params: ['latest', false] });
      return response.result.number;
    }
    return (await api<{ result: unknown }>(`/api/${namespace}/rpc`, { method: input.method, params: input.params ?? [] })).result;
  } };
}
