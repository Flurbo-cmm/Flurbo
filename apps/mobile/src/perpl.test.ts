import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePerplContext, PERPL_EXCHANGE } from './perpl.ts';
const token = '0x' + '11'.repeat(20);
const context = () => ({ chain: { chain_id: 10143 }, instances: [{ id: 12, address: PERPL_EXCHANGE, collateral_token_id: 1, min_account_open_amount: '100000000' }],
  tokens: [{ id: 1, address: token, decimals: 6, symbol: 'AUSD' }], markets: [{ id: 32, instance_id: 12, symbol: 'ETH', state: { mrk: 234567 }, config: { is_open: true, price_decimals: 2 } }] });
test('reads live testnet context using token ID linkage, not stale README addresses', () => {
  const value = parsePerplContext(context(), token);
  assert.equal(value.minimumDeposit, '100000000'); assert.equal(value.markets[0].symbol, 'ETH');
});
test('refuses mainnet, wrong collateral, unknown exchange, malformed or duplicate markets', () => {
  const mutations = [
    (v: any) => { v.chain.chain_id = 143; }, (v: any) => { v.tokens[0].address = PERPL_EXCHANGE; },
    (v: any) => { v.tokens[0].decimals = 18; }, (v: any) => { v.instances[0].address = token; },
    (v: any) => { v.markets[0].state.mrk = 'secret'; }, (v: any) => { v.markets.push(v.markets[0]); },
  ];
  for (const mutate of mutations) { const value = context(); mutate(value); assert.throws(() => parsePerplContext(value, token)); }
});
