import { BATCH_SCHEMA, batchSchema, expandPool, preparePool } from './market-batch';
import { validateSettlementPublication } from '../../../apps/web/server/settlement-publication.mjs';

export const COMPANY_SMOKE_ID = 'company-smoke-1';
const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');

export function companySmokeBatch(closesAt: number, transactions: number, gasUsed: bigint) {
  if (!Number.isSafeInteger(closesAt) || closesAt <= Math.floor(Date.now() / 1000) + 75 * 60)
    throw Error('Choose a trading close at least 75 minutes in the future');
  if (!Number.isSafeInteger(transactions) || transactions < 1 || gasUsed < 1n)
    throw Error('Recent mainnet activity is unavailable; do not invent thresholds');
  const at = closesAt + 60, opens = at + 300, ends = at + 3900;
  const rule = (eventId: string, field: string, threshold: string, unit: string) => ({
    eventId,
    question: `Will the first Monad mainnet block at or after ${iso(at)} have at least ${threshold} ${unit}, as read from the public Monad RPC during ${iso(opens)} to ${iso(ends)}?`,
    source: { id: 'monad-mainnet-rpc', publisher: 'Monad Foundation public RPC', urls: ['https://rpc.monad.xyz/'], adapter: 'evm-rpc.v1',
      reader: { chainId: 143, at: iso(at), metric: 'block-field', field, finalitySeconds: 60 } },
    observation: { series: `monad-mainnet-block-${field}`, period: iso(at), unit },
    decision: { type: 'number', operator: 'gte', value: threshold },
    window: { opens: iso(opens), closes: iso(ends) },
  });
  const batch = batchSchema.parse({ schema: BATCH_SCHEMA, defaults: { bond: '1', assertionPeriod: 3600, challengePeriod: 3600,
    votingPeriod: 3600, settlement: 'auto' }, pools: [{ id: COMPANY_SMOKE_ID, title: `Monad mainnet block activity at ${iso(at)}`,
      label: 'Monad block activity', closesAt: iso(closesAt), b: '20',
      rules: [rule('block-transactions', 'transactions', String(transactions), 'transactions'),
        rule('block-gas-used', 'gasUsed', String(gasUsed), 'gas units used')] }] });
  const expanded = expandPool(batch, COMPANY_SMOKE_ID);
  if (expanded.rules.length !== 2) throw Error('Company test needs two markets');
  return batch;
}

export function checkCompanySelection(selection: { creator: string; reviewers: { name: string; address: string }[] }, batch: ReturnType<typeof companySmokeBatch>) {
  const addresses = [selection.creator, ...selection.reviewers.map(row => row.address)].map(value => value?.toLowerCase());
  if (selection.reviewers.length !== 3 || addresses.some(value => !/^0x[0-9a-f]{40}$/.test(value)) || new Set(addresses).size !== 4)
    throw Error('Use the deployer address and three distinct new reviewer addresses');
  const oldReviewers = new Set(['0x1fc63b1f8e89473b7bea3b44fc4936b8d9416201',
    '0x41c28b86170b5ec7b261d954e0185fca348b19a4', '0x555d165001f60103c9429dbb15bf764caa8ae538']);
  if (addresses.slice(1).some(value => oldReviewers.has(value))) throw Error('Company reviewers must use new wallets');
  const prepared = preparePool(expandPool(batch, COMPANY_SMOKE_ID), selection, Math.floor(Date.now() / 1000));
  validateSettlementPublication(prepared.publication);
  return prepared;
}
