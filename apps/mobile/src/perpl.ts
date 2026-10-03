export const PERPL_CONTEXT = 'https://testnet.perpl.xyz/api/v1/pub/context';
export const PERPL_EXCHANGE = '0x1964c32f0be608e7d29302aff5e61268e72080cc';
export type PerplMarket = { id: number; symbol: string; name: string; open: boolean; mark: number; decimals: number };
export type PerplContext = { markets: PerplMarket[]; minimumDeposit: string; checkedAt: number };

// Fail closed if Perpl changes networks, exchange instances or collateral.
// Public context enables discovery only. It does not authorize an order.
export function parsePerplContext(value: any, ausd: string): PerplContext {
  if (value?.chain?.chain_id !== 10143 || !Array.isArray(value.tokens) || !Array.isArray(value.instances) || !Array.isArray(value.markets)) throw new Error('Unsupported Perpl network');
  const instances = value.instances.filter((x: any) => x.address?.toLowerCase() === PERPL_EXCHANGE);
  if (instances.length !== 1) throw new Error('Unknown Perpl exchange');
  const instance = instances[0];
  const token = value.tokens.find((x: any) => x.id === instance.collateral_token_id);
  if (token?.address?.toLowerCase() !== ausd.toLowerCase() || token.decimals !== 6 || token.symbol !== 'AUSD' || !/^[1-9]\d{0,20}$/.test(instance.min_account_open_amount)) throw new Error('Perpl collateral changed');
  const markets: PerplMarket[] = value.markets.filter((x: any) => x.instance_id === instance.id).map((x: any) => {
    if (!Number.isSafeInteger(x.id) || x.id <= 0 || !/^[A-Z0-9]{1,12}$/.test(x.symbol) || typeof x.config?.is_open !== 'boolean' ||
      !Number.isSafeInteger(x.state?.mrk) || x.state.mrk <= 0 || !Number.isInteger(x.config.price_decimals) || x.config.price_decimals < 0 || x.config.price_decimals > 8) throw new Error('Invalid Perpl market');
    return { id: x.id, symbol: x.symbol, name: `${x.symbol} perpetual`, open: x.config.is_open, mark: x.state.mrk, decimals: x.config.price_decimals };
  });
  if (!markets.length || markets.length > 100 || new Set(markets.map(x => x.id)).size !== markets.length) throw new Error('Invalid market list');
  return { markets, minimumDeposit: instance.min_account_open_amount, checkedAt: Date.now() };
}
export async function readPerplContext(ausd: string, signal?: AbortSignal): Promise<PerplContext> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, 15_000);
  try {
    const res = await fetch(PERPL_CONTEXT, { signal: controller.signal });
    if (!res.ok) throw new Error('Unavailable');
    return parsePerplContext(await res.json(), ausd);
  } catch { throw new Error('Perpl market data is unavailable. Try again shortly.'); }
  finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}
