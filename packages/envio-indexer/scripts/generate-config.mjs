import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const registry = JSON.parse(readFileSync(resolve(root, 'config/collections.json'), 'utf8'));
if (registry.schema !== 'flurbo.collections.v1') throw new Error('Unexpected collection registry');
const addresses = key => [...new Set(registry.collections.filter(c => c.status === 'active').map(c => c.manifest?.[key]?.toLowerCase()))].sort();
const pools = addresses('pool'), resolvers = addresses('resolver');
if (!pools.length || !resolvers.length || pools.some(a => !/^0x[0-9a-f]{40}$/.test(a)) || resolvers.some(a => !/^0x[0-9a-f]{40}$/.test(a))) throw new Error('Invalid registry addresses');
const yaml = [
  '# Generated from config/collections.json. Run npm run config after registry changes.',
  'name: flurbo-monad-indexer',
  'description: Flurbo pool trades and resolution events on Monad testnet',
  'address_format: lowercase',
  'contracts:',
  '  - name: PilotPool',
  '    events:',
  '      - event: "Traded(address indexed trader, uint32 indexed scope, uint256 indexed mask, bool isBuy, uint128 quantity, uint128 collateralAmount)"',
  '      - event: "Redeemed(address indexed owner, uint32 indexed scope, uint256 indexed mask, uint128 quantity, uint128 collateralAmount)"',
  '  - name: PilotResolver',
  '    events:',
  '      - event: "Asserted(uint8 indexed eventIndex, address indexed asserter, uint8 outcome, bytes32 evidenceHash, string evidenceURI, uint64 challengeUntil)"',
  '      - event: "Disputed(uint8 indexed eventIndex, address indexed disputer, uint8 outcome, bytes32 evidenceHash, string evidenceURI, uint64 voteUntil)"',
  '      - event: "Finalized(uint8 indexed eventIndex, uint8 outcome, bool timedOut)"',
  '      - event: "Delivered(address indexed pool, uint32 yesMask, uint32 voidMask)"',
  'chains:',
  '  - id: 10143',
  '    start_block: 0',
  '    contracts:',
  '      - name: PilotPool',
  '        address:',
  ...pools.map(a => `          - "${a}"`),
  '      - name: PilotResolver',
  '        address:',
  ...resolvers.map(a => `          - "${a}"`),
  ''
].join('\n');
writeFileSync(resolve(root, 'packages/envio-indexer/config.yaml'), yaml);
console.log(`Configured ${pools.length} pools and ${resolvers.length} resolvers`);
