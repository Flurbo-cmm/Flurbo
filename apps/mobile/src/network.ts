export type ConnectionCheck = { blockNumber: number; checkedAt: number };
export type NetworkTarget = { chainId: number; rpcUrl: string };

/** Public reads only. Remote text is never displayed as an error. */
export async function checkConnection(
  target: NetworkTarget,
  request: typeof fetch = fetch,
): Promise<ConnectionCheck> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const read = async (method: 'eth_chainId' | 'eth_blockNumber', id: number) => {
      const response = await request(target.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method, params: [], id }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('Connection unavailable');
      const body: unknown = await response.json();
      if (typeof body !== 'object' || body === null) throw new Error('Invalid response');
      const result = body as Record<string, unknown>;
      if (result.jsonrpc !== '2.0' || result.id !== id || 'error' in result ||
          typeof result.result !== 'string' || !/^0x[0-9a-f]{1,16}$/i.test(result.result)) {
        throw new Error('Invalid response');
      }
      const value = Number.parseInt(result.result, 16);
      if (!Number.isSafeInteger(value)) throw new Error('Invalid response');
      return value;
    };
    if (await read('eth_chainId', 1) !== target.chainId) throw new Error('Wrong network');
    const blockNumber = await read('eth_blockNumber', 2);
    if (blockNumber === 0) throw new Error('No block available');
    return { blockNumber, checkedAt: Date.now() };
  } catch {
    throw new Error('Could not verify Monad testnet. Check your connection and try again.');
  } finally {
    clearTimeout(timeout);
  }
}
