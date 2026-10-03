import {previewAccess} from './preview-access.mjs';

export const TESTNET = Object.freeze({
  environment: 'public_testnet', chain_id: 10143, name: 'Monad testnet',
  rpc: 'https://testnet-rpc.monad.xyz', explorer: 'https://testnet.monadscan.com',
  cash: '0xa9012a055bd4e0edff8ce09f960291c09d5322dc',
  faucet: '0xd236c18d274e54faccc3dd9dda4b27965a73ee6c',
  monFaucet: 'https://faucet.monad.xyz',
  faucetSelector: '0x544c7cf9',
});

// Monad testnet RPC hosts the server may read through: the public endpoint, Alchemy, and a QuickNode endpoint
// (https://<name>.monad-testnet.quiknode.pro/<token>/). Provider tokens sit in the URL path, so the configured URL
// is a secret: it is never sent to browsers or agents, and read errors never include it.
export const testnetRpcHost = hostname => ['testnet-rpc.monad.xyz', 'monad-testnet.g.alchemy.com'].includes(hostname)
  || /^[a-z0-9-]{1,63}\.monad-testnet\.quiknode\.pro$/.test(hostname);

// The provider name the Python chain readers (scripts/serve_dashboard.py) validate the configured RPC URL against.
export function readerProvider(url) {
  if (!url) return 'public';
  const host = new URL(url).hostname;
  return host === 'monad-testnet.g.alchemy.com' ? 'alchemy' : host.endsWith('.monad-testnet.quiknode.pro') ? 'quicknode' : 'public';
}

export const HOSTED_ORIGINS = new Set(['https://flurbo.singu.online', 'https://flurbopm.singu.online']);

export function hostedConfig(env = process.env) {
  if (!HOSTED_ORIGINS.has(env.FLURBO_ORIGIN)) throw new Error('Set FLURBO_ORIGIN to an approved HTTPS origin');
  if (env.FLURBO_ORIGIN === 'https://flurbopm.singu.online') {
    if (env.FLURBO_COLLECTIONS_SOURCE !== 'registry' || env.FLURBO_PILOT_DISABLED !== 'true')
      throw new Error('Company site requires its own registry and disabled legacy pilot');
    if (env.FLURBO_SETTLEMENT_BOT === 'true') {
      if (env.FLURBO_RESOLUTION_EVIDENCE_ORIGIN !== env.FLURBO_ORIGIN)
        throw new Error('Company settlement requires its own public evidence origin');
      if (env.FLURBO_MONITOR_ENABLED !== 'true' || env.FLURBO_RESOLUTION_ENABLED !== 'true')
        throw new Error('Company settlement requires its monitor and worker');
      if (env.FLURBO_RESOLUTION_PROPOSALS !== 'true')
        throw new Error('Company settlement requires deterministic proposals enabled');
      if (!/^0x[0-9a-f]{40}$/.test(env.FLURBO_RESOLUTION_SIGNER_ADDRESS?.toLowerCase() || '') ||
          env.FLURBO_RESOLUTION_SIGNER_ADDRESS?.toLowerCase() === '0x632a158d5eccc10f864ab94cec99511e1cc514f3')
        throw new Error('Company settlement requires a dedicated new signer');
    }
  }
  if (env.FLURBO_NETWORK !== 'public_testnet') throw new Error('This release supports public Monad testnet only');
  const rpc = new URL(env.FLURBO_ALCHEMY_TESTNET_RPC_URL || TESTNET.rpc);
  if (rpc.protocol !== 'https:' || rpc.username || rpc.password || rpc.hash || rpc.port ||
      !testnetRpcHost(rpc.hostname)) throw new Error('Unsupported public testnet RPC');
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid server port');
  const testFaucet = env.FLURBO_TEST_AUSD_FAUCET?.toLowerCase() || null;
  const testingOperatorAccount = env.FLURBO_TESTING_OPERATOR_ACCOUNT?.toLowerCase();
  for (const address of [testFaucet, testingOperatorAccount]) if (address && (!/^0x[0-9a-f]{40}$/.test(address) || /^0x0{40}$/.test(address))) throw Error('Invalid faucet or testing operator address');
  return { origin: env.FLURBO_ORIGIN, rpcUrl: rpc.href, port, testFaucet, testingOperatorAccount, previewAccess:previewAccess(env) };
}
