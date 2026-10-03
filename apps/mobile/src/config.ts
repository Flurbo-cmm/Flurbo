import registry from '../../../config/monad-readiness.json';

// Public testnet only. Never embed a private RPC credential in the app bundle.
export const testnet = registry.networks.testnet;
export const balanceTarget = { chainId: testnet.chain_id, rpcUrl: testnet.public_rpc,
  token: testnet.contracts.ausd, decimals: testnet.ausd_decimals };
