import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export function renderConfig(catalog) {
  const pools = Array.isArray(catalog?.pools) ? catalog.pools : [];
  const valid = address => typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address);
  if (catalog?.schema !== 'flurbo.hybrid-catalog.v1' || !pools.length || pools.some(p => !valid(p?.pool) || !valid(p?.resolver))
    || new Set(pools.map(p => p.pool.toLowerCase())).size !== pools.length) throw new Error('Invalid hybrid catalog addresses');
  const addresses = key => [...new Set(pools.map(p => p[key].toLowerCase()))].sort();
  return [
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
    ...addresses('pool').map(a => `          - "${a}"`),
    '      - name: HybridResolver',
    '        address:',
    ...addresses('resolver').map(a => `          - "${a}"`),
    ''
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const catalog = JSON.parse(readFileSync(resolve(root, 'config/hybrid-markets.json'), 'utf8'));
  writeFileSync(resolve(root, 'packages/envio-indexer/config.yaml'), renderConfig(catalog));
  console.log(`Configured ${new Set(catalog.pools.map(p => p.pool.toLowerCase())).size} pools and ${new Set(catalog.pools.map(p => p.resolver.toLowerCase())).size} resolvers`);
}
