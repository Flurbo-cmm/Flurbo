export type BalanceTarget = { chainId: number; rpcUrl: string; token: string; decimals: number };
export type WalletBalance = { owner: string; ausd: string; mon: string; block: string; checkedAt: number };
const hexInteger = (value: unknown): bigint => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{1,64}$/i.test(value)) throw new Error('Invalid integer');
  return BigInt(value);
};
export function formatAmount(atoms: string, decimals: number, places = 6) {
  if (!/^\d+$/.test(atoms) || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error('Invalid amount');
  const padded = BigInt(atoms).toString().padStart(decimals + 1, '0');
  const whole = decimals ? padded.slice(0, -decimals) : padded;
  const fraction = decimals ? padded.slice(-decimals).slice(0, places).replace(/0+$/, '') : '';
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? '.' + fraction : '');
}

export async function readBalance(target: BalanceTarget, owner: string, signal?: AbortSignal, request: typeof fetch = fetch): Promise<WalletBalance> {
  if (target.chainId !== 10143 || target.decimals !== 6 || !/^0x[0-9a-f]{40}$/i.test(owner) || !/^0x[0-9a-f]{40}$/i.test(target.token)) throw new Error('Unsupported wallet or network');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timeout = setTimeout(abort, 15_000);
  let id = 0;
  const rpc = async (method: string, params: unknown[]) => {
    const requestId = ++id;
    const res = await request(target.rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }), signal: controller.signal });
    if (!res.ok) throw new Error('Unavailable');
    const body = await res.json();
    if (body?.jsonrpc !== '2.0' || body.id !== requestId || body.error) throw new Error('Invalid response');
    return body.result;
  };
  try {
    if (hexInteger(await rpc('eth_chainId', [])) !== 10143n) throw new Error('Wrong chain');
    const block = await rpc('eth_getBlockByNumber', ['latest', false]);
    if (!block || !/^0x[0-9a-f]{64}$/i.test(block.hash) || hexInteger(block.number) === 0n) throw new Error('Invalid block');
    const token = target.token.toLowerCase();
    const code = await rpc('eth_getCode', [token, block.number]);
    if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(code)) throw new Error('Missing AUSD');
    const decimals = hexInteger(await rpc('eth_call', [{ to: token, data: '0x313ce567' }, block.number]));
    if (decimals !== 6n) throw new Error('Wrong token decimals');
    const ausd = hexInteger(await rpc('eth_call', [{ to: token, data: '0x70a08231' + owner.slice(2).toLowerCase().padStart(64, '0') }, block.number]));
    const mon = hexInteger(await rpc('eth_getBalance', [owner, block.number]));
    const canonical = await rpc('eth_getBlockByNumber', [block.number, false]);
    if (canonical?.hash !== block.hash || controller.signal.aborted) throw new Error('Snapshot changed');
    return { owner: owner.toLowerCase(), ausd: ausd.toString(), mon: mon.toString(), block: hexInteger(block.number).toString(), checkedAt: Date.now() };
  } catch {
    throw new Error('Could not refresh your balance. Check your connection and try again.');
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}
