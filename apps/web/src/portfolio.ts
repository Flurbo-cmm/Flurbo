import {decodeClaim} from '../shared/claims.mjs';
export type Market = 'original' | 'learning';
export type Position = { scope: number; mask: number; quantity_atoms: string; settlement: string; redeemable_atoms: string | null };
export type PoolEvent = { kind: string; is_buy?: boolean; scope: number; mask: string; quantity_atoms: string; collateral_atoms?: string; block_number: number; transaction_hash: string; log_index: number };
export type Portfolio = {
  market_id: Market; wallet_address: string; contracts: { pool: string; cash: string };
  index: { complete: boolean; from_block: number; through_block: number; target_block: number };
  snapshot: { block_number: number; stale: boolean; timestamp: number };
  positions: Position[] | null; position_count?: number; history: PoolEvent[] | null; history_count?: number;
  ausd_atoms?: string; receipt_atoms?: string | null; page_size?: number;
};
export const walletKey = (account: string) => `flurbo.view-wallet:${account.toLowerCase()}`;
export function rememberedWallet(account: string) {
  try { const value = sessionStorage.getItem(walletKey(account)); if (value && /^0x[\da-f]{40}$/i.test(value)) return value; } catch { /* Storage is optional. */ }
  return "";
}
export const tradingWalletKey = (account: string) => `flurbo.metamask-wallet:${account.toLowerCase()}`;
export function rememberedTradingWallet(account: string) {
  try {
    const value = sessionStorage.getItem(tradingWalletKey(account)) || rememberedWallet(account);
    if (value && value.toLowerCase() !== account.toLowerCase() && /^0x[\da-f]{40}$/i.test(value)) return value;
  } catch { /* Optional read-only display preference. */ }
  return '';
}
export function amount(value: string | undefined | null) {
  if (value == null) return 'Unavailable';
  const n = BigInt(value), whole = (n / 1000000n).toLocaleString('en-US');
  const fraction = (n % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return whole + (fraction ? '.' + fraction : '');
}
export function describeClaim(scope: number, mask: number, questions?: string[]) {
  return formatClaim(scope, mask, (event, yes) => questions?.[event]
    ? `${questions[event]} (${yes ? 'Yes' : 'No'})`
    : `${String.fromCharCode(65 + event)} ${yes ? 'YES' : 'NO'}`);
}
export function describeClaimAnswers(scope: number, mask: number) {
  return formatClaim(scope, mask, (_event, yes) => yes ? 'Yes' : 'No');
}
function formatClaim(scope: number, mask: number, label: (event: number, yes: boolean) => string) {
  const events = Array.from({ length: 8 }, (_, i) => i).filter(i => scope & (1 << i));
  const count = 1 << events.length;
  const leg = (state: number, i: number) => label(events[i], Boolean(state & (1 << i)));
  const winners = Array.from({ length: count }, (_, i) => i).filter(i => mask & (1 << i));
  if (winners.length === 1) return events.map((_, i) => leg(winners[0], i)).join(' AND ');
  if (winners.length === count - 1) {
    const loser = Array.from({ length: count }, (_, i) => i).find(i => !(mask & (1 << i)))!;
    return events.map((_, i) => leg(loser ^ (count - 1), i)).join(' OR ');
  }
  try {
    const named=decodeClaim(scope,mask);
    if(named && ['EXACTLY_ONE','AT_LEAST_TWO'].includes(named.rule)) return `${named.rule==='EXACTLY_ONE'?'Exactly one':'At least two'} of: `+named.legs.map(l=>label(l.event,l.yes)).join(' / ');
  } catch { /* Legacy shapes keep their explicit truth-table description. */ }
  return winners.map(state => '(' + events.map((_, i) => leg(state, i)).join(' AND ') + ')').join(' OR ');
}
