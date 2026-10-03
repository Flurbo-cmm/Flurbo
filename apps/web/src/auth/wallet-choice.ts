import { isMetaMask } from '../../../dashboard/metamask.mjs';
export type BrowserWallet = { name: string; provider: { request(args: {method: string; params?: unknown[]}): Promise<unknown> } };

export function discoverWallets(receive: (wallet: BrowserWallet) => void) {
  const seen = new Set<unknown>();
  const add = (wallet: BrowserWallet) => {
    if (!wallet?.provider?.request || seen.has(wallet.provider)) return;
    seen.add(wallet.provider); receive({ ...wallet, name: 'MetaMask' });
  };
  const announced = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (detail && isMetaMask(detail.provider, detail.info)) add({ name: 'MetaMask', provider: detail.provider });
  };
  window.addEventListener('eip6963:announceProvider', announced);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  const injected = (window as unknown as {ethereum?: BrowserWallet['provider']}).ethereum;
  if (!seen.size && isMetaMask(injected)) add({ name: 'MetaMask', provider: injected! });
  return () => window.removeEventListener('eip6963:announceProvider', announced);
}
