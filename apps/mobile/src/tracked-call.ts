export type ReadProvider = { request(input: { method: string; params?: unknown[] }): Promise<unknown> };
export type TrackedCall = { hash: string | null; tx: Record<string, string>; nonce: string; started: number };
const integer = (v: unknown) => {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 || typeof v === 'string' && /^0x[0-9a-f]{1,64}$/i.test(v)) return BigInt(v);
  throw new Error('Invalid wallet integer.');
};
export async function submitTracked(p: ReadProvider, tx: Record<string, string>, current: () => boolean, save: (v: TrackedCall | null) => void, flush: () => Promise<void>) {
  const nonce = '0x' + integer(await p.request({ method: 'eth_getTransactionCount', params: [tx.from, 'pending'] })).toString(16);
  if (!current()) throw new Error('Trading account changed.');
  const value: TrackedCall = { tx, nonce, hash: null, started: Date.now() };
  save(value); await flush();
  // Nothing has reached a signing provider yet, so this cancellation is known.
  if (!current()) { save(null); await flush(); throw new Error('Account or review changed before confirmation.'); }
  try {
    const hash = await p.request({ method: 'eth_sendTransaction', params: [{ ...tx, nonce }] });
    if (typeof hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error('No transaction hash returned.');
    save({ ...value, hash }); await flush(); return hash;
  } catch (e) {
    if ((e as { code?: number }).code === 4001) { save(null); await flush(); throw new Error('Wallet request declined.'); }
    throw new Error('Submission outcome unknown. Check wallet activity and attach the hash.');
  }
}
export async function checkTracked(p: ReadProvider, saved: TrackedCall) {
  if (!saved.hash || !/^0x[0-9a-f]{64}$/i.test(saved.hash)) throw new Error('Attach the transaction hash from wallet activity.');
  const tx = await p.request({ method: 'eth_getTransactionByHash', params: [saved.hash] }) as any;
  const receipt = await p.request({ method: 'eth_getTransactionReceipt', params: [saved.hash] }) as any;
  if (!tx || !receipt) return 'pending';
  const lower = (v: unknown) => String(v).toLowerCase();
  if (lower(tx.hash) !== lower(saved.hash) || lower(receipt.transactionHash) !== lower(saved.hash) || lower(tx.from) !== lower(saved.tx.from) || lower(tx.to) !== lower(saved.tx.to) || lower(tx.input) !== lower(saved.tx.data) || integer(tx.nonce) !== integer(saved.nonce) || integer(tx.value) !== 0n || integer(tx.chainId) !== 10143n || tx.blockHash !== receipt.blockHash || tx.blockNumber !== receipt.blockNumber) throw new Error('Transaction differs from the reviewed call. Tracking stays open.');
  const block = await p.request({ method: 'eth_getBlockByNumber', params: [receipt.blockNumber, false] }) as any;
  const head = await p.request({ method: 'eth_getBlockByNumber', params: ['latest', false] }) as any;
  if (block?.hash !== receipt.blockHash || integer(head.number) < integer(receipt.blockNumber) + 1n) return 'confirming';
  if (![0n, 1n].includes(integer(receipt.status))) throw new Error('Invalid receipt.');
  return integer(receipt.status) === 1n ? 'confirmed' : 'reverted';
}
