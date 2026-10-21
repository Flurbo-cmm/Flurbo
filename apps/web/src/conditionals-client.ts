// Typed calls to /api/conditionals. The server prepares every transaction; the page only reviews and sends it.
import { appFetch } from './platform-fetch';
import type { BrowserWallet } from './auth/wallet-choice';
import { conditionalPendingKey, readConditionalPending, type ConditionalPending } from './pending-readers';
import type { Chances, DecodedLegs, Leg } from './conditional-view';

export type WireShape = { conditionScope: number; conditionMask: string; targetScope: number; targetMask: string };
export type ConditionalDirectory = { schema: string; pools: { id: string; pool: string; title: string; questions: string[]; closesAt: number }[] };
export type PoolQuestion = { eventIndex: number; question: string; route: 'mechanical' | 'reality'; observationEndsAt: number;
  chance: number | null; pairable: number[] };
export type ConditionalPool = { schema: string; id: string; pool: string; title: string; closesAt: number; open: boolean; resolved: boolean;
  resolvedState: number | null; voidMask: number | null; observedAt: number; blockNumber: string; blockHash: string;
  combinationLimit: string; questions: PoolQuestion[] };
export type ChancesResult = { values: Chances; reasons: Record<string, string>; pairable: boolean; open: boolean; observedAt: number; blockNumber: string };
export type ConditionalQuote = { shape: WireShape; key: string; shares: string; priceAtoms: string; payAtoms: string; perShare: string;
  refundAtoms: string; payoffs: { both: string; conditionOnly: string; refund: string }; chances: Chances; reasons: Record<string, string>;
  reads: number; observedAt: number; cashAtoms: string | null; allowanceAtoms: string | null };
export type Transaction = { chainId: number; from: string; to: string; data: string; value: string };
export type ConditionalPlan = { action: string; reason: string; amountAtoms?: string; payAtoms?: string; priceAtoms?: string; maxCostAtoms?: string;
  minimumReceivedAtoms?: string; expiresAt?: number; transaction: Transaction };
export type QuestionQuote = { action: 'quote'; buyAtoms: string; maxCostAtoms: string; cashAtoms: string; allowanceAtoms: string; holdingsAtoms: string };
export type Holding = { key: string; shape: WireShape; condition: DecodedLegs; target: DecodedLegs; sharesAtoms: string; refundAtoms: string;
  sellAtoms: string | null; payoutAtoms: string | null };
export type Holdings = { wallet: string; open: boolean; resolved: boolean; holdings: Holding[] };

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await appFetch(`/api/conditionals${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    cache: 'no-store', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(Error(value.error || 'Conditional request unavailable. Refresh and retry.'), { status: response.status });
  return value as T;
}

const legs = (leg: Leg) => [{ eventIndex: leg.eventIndex, side: leg.side }];
export const loadDirectory = () => call<ConditionalDirectory>('');
export const loadPool = (pool: string) => call<ConditionalPool>(`/${pool}`);
export const loadChances = (pool: string, condition: Leg, target: Leg) =>
  call<ChancesResult>(`/${pool}/chances`, { condition: legs(condition), target: legs(target) });
export const loadQuote = (pool: string, condition: Leg, target: Leg, shares: string, owner: string | null) =>
  call<ConditionalQuote>(`/${pool}/quote`, { condition: legs(condition), target: legs(target), shares, ...(owner ? { owner } : {}) });
export const prepareConditional = (pool: string, action: string, input: unknown, owner: string) =>
  call<ConditionalPlan>(`/${pool}/action`, { action, input, owner });
export const loadHoldings = (pool: string, wallet: string) => call<Holdings>(`/${pool}/holdings?wallet=${wallet}`);
export const questionAction = <T>(pool: string, eventIndex: number, action: string, input: unknown, owner: string) =>
  call<T>(`/${pool}-${eventIndex}/action`, { action, input, owner });
export const tradeInput = (condition: Leg, target: Leg, shares: string) => ({ condition: legs(condition), target: legs(target), shares });

// Monad testnet is the only network a conditional transaction uses.
export async function ensureMonad(provider: BrowserWallet['provider']) {
  const chainId = '0x279f';
  if (await provider.request({ method: 'eth_chainId' }) === chainId) return;
  try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] }); }
  catch (error) {
    if ((error as { code?: number })?.code !== 4902) throw error;
    await provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId, chainName: 'Monad Testnet',
      nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: ['https://testnet-rpc.monad.xyz'],
      blockExplorerUrls: ['https://testnet.monadscan.com'] }] });
  }
  if (await provider.request({ method: 'eth_chainId' }) !== chainId) throw Error('Switch MetaMask to Monad testnet.');
}

export const readPending = readConditionalPending;
export function savePending(value: ConditionalPending | null) {
  if (value) sessionStorage.setItem(conditionalPendingKey, JSON.stringify(value));
  else sessionStorage.removeItem(conditionalPendingKey);
  window.dispatchEvent(new Event('flurbo:pending'));
}
