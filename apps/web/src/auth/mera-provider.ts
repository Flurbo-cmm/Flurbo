import { appFetch as fetch } from '../platform-fetch.ts';
import type { AuthController } from './controller';
import { WalletError } from '../../../dashboard/wallet.mjs';

async function rpcRequest(method: string, params: unknown[] = [], market = 'original') {
  const response = await fetch('/api/rpc', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params, market }), signal: AbortSignal.timeout(20_000) });
  const value = await response.json();
  if (!response.ok || value.error) throw new WalletError('Monad request failed. Check transaction tracking before retrying.');
  return value.result;
}

// Compatibility adapter for reading historical Mera holdings. Signing is disabled.
export function meraProvider(controller: AuthController, market: 'original' | 'learning' = 'original') {
  const rpc = (method: string, params: unknown[] = []) => rpcRequest(method, params, market);
  const listeners = new Map<string, Set<() => void>>();
  let previous = controller.getSnapshot().address;
  const unsubscribe = controller.subscribe(() => {
    const current = controller.getSnapshot().address;
    if (current?.toLowerCase() !== previous?.toLowerCase()) { previous = current; listeners.get('accountsChanged')?.forEach(fn => fn()); }
  });
  return {
    on(name: string, fn: () => void) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(fn); },
    removeListener(name: string, fn: () => void) { listeners.get(name)?.delete(fn); },
    destroy() { unsubscribe(); listeners.clear(); },
    async request({ method, params = [] }: { method: string; params?: unknown[] }) {
      const owner = controller.getSnapshot().address;
      if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return owner ? [owner.toLowerCase()] : [];
      if (['eth_sendTransaction','eth_sendRawTransaction','eth_sign','personal_sign','eth_signTypedData_v4'].includes(method)) throw new WalletError('Mera is for account access only. Use MetaMask for transactions.');
      if (!['eth_chainId', 'eth_getBlockByNumber', 'eth_call', 'eth_estimateGas', 'eth_gasPrice', 'eth_getBalance', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getTransactionCount'].includes(method)) throw new Error('Unsupported wallet request');
      return rpc(method, params);
    },
  };
}
