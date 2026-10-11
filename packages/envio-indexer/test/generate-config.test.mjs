import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { renderConfig } from '../scripts/generate-config.mjs';

const pool = (address, resolver) => ({ id: 'p', pool: address, resolver, rulesHash: '0x' + '1'.repeat(64), deploymentBlock: 1, prepared: {} });
const catalog = pools => ({ schema: 'flurbo.hybrid-catalog.v1', pools });

test('renders the hybrid pool and resolver contracts with sorted unique lowercase addresses', () => {
  const yaml = renderConfig(catalog([pool('0x' + 'B'.repeat(40), '0x' + 'D'.repeat(40)), pool('0x' + 'a'.repeat(40), '0x' + 'd'.repeat(40))]));
  assert.equal(yaml, [
    '# Generated from config/hybrid-markets.json. Run npm run config after registry changes.',
    'name: flurbo-company-monad-indexer',
    'description: Flurbo company pool trades and resolution events on Monad testnet',
    'address_format: lowercase',
    'contracts:',
    '  - name: HybridPool',
    '    events:',
    '      - event: "Traded(address indexed trader, uint32 indexed scope, uint256 indexed mask, bool isBuy, uint128 quantity, uint128 collateralAmount)"',
    '      - event: "Redeemed(address indexed owner, uint32 indexed scope, uint256 indexed mask, uint128 quantity, uint128 collateralAmount)"',
    '  - name: HybridResolver',
    '    events:',
    '      - event: "Proposed(uint8 indexed eventIndex, uint8 outcome, bytes32 evidenceHash, string evidenceURI, uint64 challengeUntil)"',
    '      - event: "Challenged(uint8 indexed eventIndex, address indexed challenger, bytes32 indexed requestId, uint8 counter, bytes32 evidenceHash, string evidenceURI, uint64 arbitrationUntil)"',
    '      - event: "RulingReported(uint8 indexed eventIndex, bytes32 indexed sourceCaseId, uint8 outcome, bytes32 evidenceHash, string evidenceURI)"',
    '      - event: "RealityReported(uint8 indexed eventIndex, uint8 outcome, bytes32 evidenceHash, string evidenceURI)"',
    '      - event: "Finalized(uint8 indexed eventIndex, uint8 outcome, bool timedOut)"',
    '      - event: "Delivered(address indexed pool, uint32 yesMask, uint32 voidMask)"',
    'chains:',
    '  - id: 10143',
    '    start_block: 0',
    '    contracts:',
    '      - name: HybridPool',
    '        address:',
    `          - "0x${'a'.repeat(40)}"`,
    `          - "0x${'b'.repeat(40)}"`,
    '      - name: HybridResolver',
    '        address:',
    `          - "0x${'d'.repeat(40)}"`,
    '',
  ].join('\n'));
});

test('refuses a catalog that is not a hybrid catalog with valid unique pools', () => {
  const good = pool('0x' + 'a'.repeat(40), '0x' + 'b'.repeat(40));
  for (const value of [
    { ...catalog([good]), schema: 'flurbo.collections.v1' }, catalog([]), { schema: 'flurbo.hybrid-catalog.v1' },
    catalog([{ ...good, pool: '0x1234' }]), catalog([{ ...good, resolver: 'not an address' }]),
    catalog([good, { ...good, pool: good.pool.toUpperCase().replace('0X', '0x') }]),
  ]) assert.throws(() => renderConfig(value), /^Error: Invalid hybrid catalog addresses$/);
});

test('the committed config.yaml is the rendering of config/hybrid-markets.json', () => {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  assert.equal(read('../config.yaml').replace(/\r\n/g, '\n'), renderConfig(JSON.parse(read('../../../config/hybrid-markets.json'))));
});
