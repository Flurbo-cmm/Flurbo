declare module '*.mjs' {
  export function isMetaMask(provider: unknown, info?: {rdns?: string}): boolean;
  export function supportedDeployment(state: unknown): boolean;
  export const TESTNET: { environment: string; chain_id: number; name: string; rpc: string; explorer: string; cash: string; faucet: string; monFaucet: string; faucetSelector: string };
  export function validWithdrawal(input: {to?: string; data?: string; account?: string; cash?: string; pool?: string}): boolean;
  export class WalletError extends Error {}
  export function mountDashboard(root: ShadowRoot, options?: { account?: string; consumer?: boolean; credentials?: string; marketId?: 'original' | 'learning'; verifyWallet?: (provider: any, address: string) => Promise<void>; onWallet?: (address: string | null) => void; onBusy?: (busy: boolean) => void; providers?: {name: string; provider: unknown}[]; onSnapshot?: (data: unknown) => void }): () => void;
}
