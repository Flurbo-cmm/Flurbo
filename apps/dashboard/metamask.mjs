// Wallet discovery is an application filter, not cryptographic wallet attestation.
export function isMetaMask(provider, info) {
  if (!provider || typeof provider.request !== 'function') return false;
  if (provider.isPhantom || provider.isRabby || provider.isCoinbaseWallet || provider.isBraveWallet) return false;
  return info ? info.rdns === 'io.metamask' : provider.isMetaMask === true;
}
