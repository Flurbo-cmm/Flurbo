export const REOWN_PROJECT_ID = '0cad064df31aeae313f0ab3ee7620ed7';
export const CHAIN = 'eip155:10143';
export function sessionAddress(session: { peer?: { metadata?: { name?: string; url?: string } }; expiry: number; namespaces: Record<string, { accounts: string[]; methods: string[]; events: string[] }> }, now = Date.now()) {
  // Wallet metadata filters app connections; it is not cryptographic brand attestation.
  if (!/^MetaMask(?:: Web3 Wallet| Mobile)?$/i.test(session.peer?.metadata?.name ?? '') || !/^https:\/\/(?:[a-z0-9-]+\.)?metamask\.io(?:\/|$)/i.test(session.peer?.metadata?.url ?? '')) throw new Error('Only MetaMask is supported for trading. Reconnect MetaMask.');
  const ns = session.namespaces.eip155;
  if (session.expiry * 1000 <= now || !ns?.methods.includes('eth_sendTransaction')) throw new Error('Reconnect MetaMask on Monad testnet.');
  const accounts = ns.accounts.filter(a => /^eip155:10143:0x[0-9a-f]{40}$/i.test(a));
  if (accounts.length !== 1) throw new Error('Select one MetaMask account on Monad testnet.');
  return accounts[0].split(':')[2].toLowerCase();
}
export function checkWalletTransaction(value: unknown, owner: string) {
  const tx = value as Record<string, unknown>;
  if (!tx || typeof tx.from !== 'string' || tx.from.toLowerCase() !== owner ||
    typeof tx.to !== 'string' || !/^0x[0-9a-f]{40}$/i.test(tx.to) ||
    BigInt(String(tx.chainId)) !== 10143n || BigInt(String(tx.value ?? '0x0')) !== 0n ||
    typeof tx.data !== 'string' || !/^0x([0-9a-f]{2})*$/i.test(tx.data)) throw new Error('Wallet transaction does not match this testnet account.');
  return tx;
}
