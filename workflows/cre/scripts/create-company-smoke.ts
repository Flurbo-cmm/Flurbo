import { mkdir, writeFile } from 'node:fs/promises';
import { companySmokeBatch, COMPANY_SMOKE_ID } from '../src/company-smoke';

const RPC = 'https://rpc.monad.xyz/';
async function rpc(method: string, params: unknown[]) {
  const response = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
  const body = await response.json() as { result?: any; error?: unknown };
  if (!response.ok || body.error || !body.result) throw Error('Monad mainnet RPC unavailable');
  return body.result;
}

const head = await rpc('eth_blockNumber', []);
const block = await rpc('eth_getBlockByNumber', [head, false]);
const transactions = block.transactions.length;
const gasUsed = BigInt(block.gasUsed);
const now = Math.floor(Date.now() / 1000);
const closesAt = Math.ceil((now + 24 * 3600) / 3600) * 3600;
const batch = companySmokeBatch(closesAt, transactions, gasUsed);
const file = new URL(`../../../config/markets/${COMPANY_SMOKE_ID}.json`, import.meta.url);
await mkdir(new URL('../../../config/markets/', import.meta.url), { recursive: true });
await writeFile(file, JSON.stringify(batch, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ file: `config/markets/${COMPANY_SMOKE_ID}.json`, id: COMPANY_SMOKE_ID,
  marketCount: 2, closesAt: new Date(closesAt * 1000).toISOString(),
  thresholdSourceBlock: head, transactionsThreshold: transactions, gasUsedThreshold: gasUsed.toString() }, null, 2));
