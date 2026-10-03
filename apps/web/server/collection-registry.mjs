import { readFile } from 'node:fs/promises';
import { pilotService } from './pilot.mjs';
import { validateActivityDraft } from '../shared/ethereum-activity.mjs';
import { DETERMINISTIC_MODE, validateSettlementManifest } from './settlement-publication.mjs';

// One committed file lists every collection the site shows, the monitor watches and the settlement bot handles.
// It holds public deployment data only (verified manifests); secrets and switches stay in the environment. The
// registry is opted into with FLURBO_COLLECTIONS_SOURCE=registry; without it the environment bundles apply as before.
export const REGISTRY_SCHEMA = 'flurbo.collections.v1';
export const REGISTRY_FILE = new URL('../../../config/collections.json', import.meta.url);
export const MAX_LISTED_COLLECTIONS = 24;
export const MAX_WATCHED_COLLECTIONS = 31; // plus the release pilot: the monitor reads at most 32 pools
// auto: the bot reads the committed sources and asserts answers. finish-only: the bot only finalizes elapsed
// deadlines and delivers. off: the bot leaves the pool alone (the monitor still watches it while it is listed).
export const SETTLEMENT_MODES = ['auto', 'finish-only', 'off'];
export const REGISTRY_STATUSES = ['active', 'retired'];
// A bad registry entry could otherwise ask the settlement signer to approve a large bond for any contract.
export const MAX_AUTO_BOND_ATOMS = 10_000_000n;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ()-]{2,59}$/;
const COLLECTION_MODES = ['rehearsal', 'ethereum-activity', DETERMINISTIC_MODE];
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function registryEnabled(env = process.env) {
  const value = env.FLURBO_COLLECTIONS_SOURCE;
  if (value === undefined || value === '') return false;
  if (value !== 'registry') throw Error('FLURBO_COLLECTIONS_SOURCE must be "registry" or unset');
  return true;
}

// Static checks only: no chain reads. Every read of a pool later re-verifies its code, rules hash and binding.
export function validateRegistry(registry) {
  if (!exact(registry, ['schema', 'featured', 'pilotSettlement', 'collections']) || registry.schema !== REGISTRY_SCHEMA
    || !Array.isArray(registry.collections) || !SETTLEMENT_MODES.includes(registry.pilotSettlement)) throw Error('Invalid collection registry');
  const pools = new Set(), resolvers = new Set(), labels = new Set();
  for (const row of registry.collections) {
    if (!exact(row, ['label', 'settlement', 'status', 'manifest']) || typeof row.label !== 'string' || !LABEL.test(row.label)
      || !SETTLEMENT_MODES.includes(row.settlement) || !REGISTRY_STATUSES.includes(row.status)) throw Error('Invalid collection registry entry');
    const manifest = row.manifest, mode = manifest?.publication?.mode;
    if (!COLLECTION_MODES.includes(mode)) throw Error(`Unsupported collection mode for ${row.label}`);
    pilotService({ manifest, rpc: async () => { throw Error('No read during configuration'); } });
    if (mode === DETERMINISTIC_MODE) validateSettlementManifest(manifest);
    if (mode === 'ethereum-activity') validateActivityDraft(manifest.publication.draft);
    if (row.settlement === 'auto' && BigInt(manifest.publication.bondAtoms) > MAX_AUTO_BOND_ATOMS) throw Error(`${row.label}: bond above the automatic settlement limit`);
    const pool = manifest.pool.toLowerCase(), resolver = manifest.resolver.toLowerCase();
    if (pools.has(pool) || resolvers.has(resolver) || labels.has(row.label)) throw Error(`Duplicate collection ${row.label}`);
    pools.add(pool); resolvers.add(resolver); labels.add(row.label);
  }
  const active = registry.collections.filter(row => row.status === 'active');
  if (active.length > MAX_LISTED_COLLECTIONS) throw Error(`At most ${MAX_LISTED_COLLECTIONS} listed collections are supported`);
  // The monitor watches the release pilot plus these; set settled retired pools to "off" to stop watching them.
  if (monitoredCollections(registry).length > MAX_WATCHED_COLLECTIONS) throw Error(`At most ${MAX_WATCHED_COLLECTIONS} collections can be watched; set settled retired pools to "off"`);
  if (registry.featured !== null && !active.some(row => row.manifest.pool === registry.featured)) throw Error('The featured pool must be an active collection');
  if (registry.featured === null && active.length) throw Error('Choose a featured pool');
  return registry;
}

export async function loadRegistry({ read = readFile, file = REGISTRY_FILE } = {}) {
  return validateRegistry(JSON.parse(await read(file, 'utf8')));
}

// The site lists active collections. The monitor watches every pool the bot may act on, plus every listed pool.
export const listedCollections = registry => registry.collections.filter(row => row.status === 'active');
export const monitoredCollections = registry => registry.collections.filter(row => row.status === 'active' || row.settlement !== 'off');

// FLURBO_RESOLUTION_HOLD: pools the bot must not assert for (for example while an operator checks a source by
// hand). They are still finalized after elapsed deadlines and delivered.
export function heldPools(env = process.env) {
  const value = env.FLURBO_RESOLUTION_HOLD ?? '';
  const pools = value.split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
  if (pools.some(pool => !/^0x[0-9a-f]{40}$/.test(pool))) throw Error('FLURBO_RESOLUTION_HOLD lists pool addresses separated by commas');
  return new Set(pools);
}
