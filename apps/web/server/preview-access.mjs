// Approval belongs to a verified Mera identity, never a supplied trading wallet.
export function previewAccess(env = {}) {
  const addresses = (env.FLURBO_TESTNET_APPROVED_ACCOUNTS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  if (addresses.some(x => !/^0x[0-9a-f]{40}$/.test(x) || /^0x0{40}$/.test(x))) throw Error('Invalid approved Mera account list');
  const approved = new Set(addresses);
  let applicationUrl = null;
  if (env.FLURBO_TESTNET_APPLICATION_URL) {
    const url = new URL(env.FLURBO_TESTNET_APPLICATION_URL);
    const email=url.protocol==='mailto:'&&!url.search&&!url.hash&&/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(url.pathname);
    if ((!email&&url.protocol !== 'https:') || url.username || url.password) throw Error('Application URL must use HTTPS or a single mailto address');
    applicationUrl = url.href;
  }
  return {applicationUrl, allows: session => session?.method === 'passkey' && approved.has(session.address?.toLowerCase())};
}
