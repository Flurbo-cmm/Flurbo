import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { batchSchema, expandPool, preparePool, judgeCheck, fundingAtoms } from '../src/market-batch';
import { verifyPilot } from '../src/pilot-verification';
import { checkRule } from '../../../apps/web/scripts/check-settlement-rule.mjs';
import { validateRegistry, REGISTRY_SCHEMA, SETTLEMENT_MODES, REGISTRY_STATUSES } from '../../../apps/web/server/collection-registry.mjs';

// One command for every step of listing pools, for any number of pools at once:
//   prepare --spec <batch.json> [--pools a,b]   build <id>-prepared.json for each pool after checking every rule live
//   check --ids a,b                             before deploying: deadlines, rule checks, funding and gas for the batch
//   (deploy)                                    FLURBO_DEPLOY_IDS=a,b forge script contracts/script/DeployPilotBatch.s.sol:DeployPilotBatch ...
//   verify --ids a,b                            check each deployment against the chain and write <id>-testnet.json
//   register --ids a,b [--settlement auto] [--feature <id>]   add verified pools to config/collections.json
//   import --bundle <file> [--settlement finish-only]         start config/collections.json from an environment bundle
//   set <pool or label> settlement=<mode> | status=<status> | featured
// Nothing here signs, deploys or sends a transaction; deploying is the forge command, run by the operator.
const root = new URL('../../../', import.meta.url);
const deployments = (name: string) => new URL(`target/deployments/${name}`, root);
const REGISTRY = new URL('config/collections.json', root);
const RPC = process.env.FLURBO_ALCHEMY_TESTNET_RPC_URL || 'https://testnet-rpc.monad.xyz';
const AUSD = '0xa9012a055bd4e0edff8ce09f960291c09d5322dc';
const DEPLOY_MARGIN_SECONDS = 75 * 60; // the deploy refuses a close less than one hour after its transaction
const iso = (s: number) => new Date(s * 1000).toISOString().replace('.000Z', 'Z');
const now = () => Math.floor(Date.now() / 1000);
const json = async (url: URL | string) => JSON.parse(await readFile(url, 'utf8'));
const exists = async (url: URL) => Bun.file(url).exists();
const out = (value: unknown) => console.log(JSON.stringify(value, null, 2));

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
const ids = (value = flag('ids')) => {
  const list = (value ?? '').split(',').map(v => v.trim()).filter(Boolean);
  if (!list.length || list.some(id => !/^[a-z0-9][a-z0-9-]{2,40}$/.test(id)) || new Set(list).size !== list.length) throw Error('List pool ids with --ids a,b');
  return list;
};

async function rpc(method: string, params: unknown[]) {
  const response = await fetch(RPC, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
  const body = await response.json() as { result?: string; error?: unknown };
  if (!response.ok || body.error || body.result === undefined) throw Error(`RPC ${method} failed`);
  return body.result;
}
const ausdBalance = async (owner: string) => BigInt(await rpc('eth_call', [{ to: AUSD, data: '0x70a08231' + owner.slice(2).toLowerCase().padStart(64, '0') }, 'latest']));

async function checkRules(rules: any[], closesAt: number, expected: Record<string, string[]> = {}) {
  const rows = [];
  for (const rule of rules) {
    const report: any = await checkRule(rule, { closesAt });
    rows.push({ event: rule.eventId, status: report.status, verdict: judgeCheck(report, expected[rule.eventId]), message: report.message,
      sources: report.sources?.map((s: any) => ({ result: s.result, reason: s.reason, value: s.value, bytes: s.bytes })) });
  }
  return rows;
}

async function prepare() {
  const specFile = flag('spec');
  if (!specFile) throw Error('Use prepare --spec <batch.json> [--pools a,b]');
  const batch = batchSchema.parse(await json(resolve(specFile)));
  const chosen = flag('pools') ? ids(flag('pools')) : batch.pools.map(p => p.id);
  const selection = await json(new URL('config/pilot-alpha-selection.json', root));
  await mkdir(deployments(''), { recursive: true });
  const results = [];
  for (const id of chosen) {
    const pool = expandPool(batch, id), at = now();
    if (pool.closesAt <= at + DEPLOY_MARGIN_SECONDS) throw Error(`${id}: trading closes too soon to deploy (${iso(pool.closesAt)})`);
    const prepared = preparePool(pool, selection, at);
    const checks = await checkRules(prepared.publication.settlementRules!, pool.closesAt, pool.expectPending);
    if (checks.some(c => c.verdict === 'blocked')) { out({ id, status: 'blocked', checks }); throw Error(`${id}: a rule check failed; nothing was written`); }
    const target = deployments(`${id}-prepared.json`);
    if (await exists(target)) {
      if ((await json(target)).configHash !== prepared.configHash) throw Error(`${id}: an earlier preparation differs. Keep it, or move it aside before preparing again.`);
    } else await writeFile(target, JSON.stringify(prepared, null, 2) + '\n', { flag: 'wx' });
    await writeFile(deployments(`${id}-listing.json`), JSON.stringify({ label: pool.label, settlement: pool.settlement }, null, 2) + '\n');
    results.push({ id, configHash: prepared.configHash, closes: iso(pool.closesAt), questions: pool.rules.length,
      fundingAusd: Number(fundingAtoms(pool.liquidityAtoms, pool.rules.length)) / 1e6, checks: checks.map(c => `${c.event}: ${c.verdict}`) });
  }
  out({ status: 'prepared', pools: results, next: `bun workflows/cre/scripts/batch.ts check --ids ${chosen.join(',')}` });
}

async function check() {
  const list = ids(), at = now(), registry = await exists(REGISTRY) ? validateRegistry(await json(REGISTRY)) : null;
  const pools = [], problems: string[] = [];
  let funding = 0n, creator = '';
  for (const id of list) {
    const prepared = await json(deployments(`${id}-prepared.json`));
    const closesAt = prepared.publication.draft.closesAt, rules = prepared.publication.settlementRules ?? [];
    creator ||= prepared.creator;
    if (prepared.creator !== creator) problems.push(`${id}: prepared for a different deployer`);
    if (closesAt <= at + DEPLOY_MARGIN_SECONDS) problems.push(`${id}: trading closes at ${iso(closesAt)}, too soon to deploy`);
    if (await exists(deployments(`${id}-unverified.json`))) problems.push(`${id}: already has an unverified deployment manifest`);
    if (registry?.collections.some((r: any) => r.manifest.draftHash === prepared.draftHash)) problems.push(`${id}: already registered`);
    const checks = rules.length ? await checkRules(rules, closesAt) : [];
    for (const c of checks) if (['invalid', 'already-public'].includes(c.status)) problems.push(`${id}/${c.event}: ${c.status}`);
    const need = fundingAtoms(prepared.liquidityAtoms, prepared.eventHashes.length);
    funding += BigInt(need);
    pools.push({ id, closes: iso(closesAt), deployBefore: iso(closesAt - 3600), questions: prepared.eventHashes.length, fundingAusd: Number(need) / 1e6,
      checks: checks.map(c => ({ event: c.event, status: c.status, reasons: c.sources?.map((s: any) => s.reason ?? s.result) })) });
  }
  const balance = await ausdBalance(creator), gas = BigInt(await rpc('eth_getBalance', [creator, 'latest']));
  if (balance < funding) problems.push(`deployer holds ${Number(balance) / 1e6} test AUSD; the batch needs ${Number(funding) / 1e6}`);
  // Measured: 1.4 to 1.6 MON per four-question deployment; forge estimated about 2.4 per pool at 203 gwei. Keep a margin.
  if (gas < BigInt(list.length) * 3n * 10n ** 18n) problems.push(`deployer holds ${Number(gas) / 1e18} MON; keep at least 3 MON per pool`);
  out({ status: problems.length ? 'blocked' : 'ready', pools, totalFundingAusd: Number(funding) / 1e6, deployerAusd: Number(balance) / 1e6,
    deployerMon: Number(gas) / 1e18, problems,
    note: 'source-error before a release (404, empty list, missing row) is expected; review each reason above.',
    deploy: `FOUNDRY_PROFILE=demo FLURBO_DEPLOY_IDS=${list.join(',')} forge script contracts/script/DeployPilotBatch.s.sol:DeployPilotBatch --use target/tools/solc-0.8.28.exe --rpc-url https://testnet-rpc.monad.xyz --account flurbo-testnet --sender "$FLURBO_DEPLOYER" --broadcast --slow` });
  if (problems.length) process.exitCode = 2;
}

async function verify() {
  const artifacts: Record<string, any> = {};
  for (const name of ['PilotPool', 'PilotResolver', 'FactoredBaseTokenFactory', 'FactoredBaseToken'])
    artifacts[name] = await json(new URL(`target/foundry/out/${name}.sol/${name}.json`, root));
  const results = [];
  for (const id of ids()) {
    const prepared = await json(deployments(`${id}-prepared.json`)), deployment = await json(deployments(`${id}-unverified.json`));
    const manifest = await verifyPilot(prepared, deployment, rpc, artifacts, now());
    await writeFile(deployments(`${id}-testnet.json`), JSON.stringify(manifest, null, 2) + '\n');
    results.push({ id, status: manifest.status, pool: manifest.pool, rulesHash: manifest.rulesHash, block: manifest.verifiedBlock });
  }
  out({ status: 'verified', pools: results });
}

const emptyRegistry = () => ({ schema: REGISTRY_SCHEMA, featured: null, pilotSettlement: 'finish-only', collections: [] as any[] });
async function saveRegistry(registry: any) {
  validateRegistry(registry);
  await writeFile(REGISTRY, JSON.stringify(registry, null, 2) + '\n');
  out({ status: 'registry_written', file: 'config/collections.json', featured: registry.featured,
    collections: registry.collections.map((r: any) => ({ label: r.label, pool: r.manifest.pool, settlement: r.settlement, status: r.status })),
    next: 'Review and commit config/collections.json. Render picks it up on the next deploy when FLURBO_COLLECTIONS_SOURCE=registry.' });
}

async function register() {
  const registry = await exists(REGISTRY) ? await json(REGISTRY) : emptyRegistry();
  const mode = flag('settlement'), feature = flag('feature');
  if (mode && !SETTLEMENT_MODES.includes(mode)) throw Error(`--settlement is one of ${SETTLEMENT_MODES.join(', ')}`);
  for (const id of ids()) {
    const manifest = await json(deployments(`${id}-testnet.json`));
    const listing = await exists(deployments(`${id}-listing.json`)) ? await json(deployments(`${id}-listing.json`)) : {};
    if (registry.collections.some((r: any) => r.manifest.pool === manifest.pool)) throw Error(`${id} is already registered`);
    registry.collections.push({ label: listing.label ?? manifest.publication.draft.title, settlement: mode ?? listing.settlement ?? 'auto', status: 'active', manifest });
    if (feature === id || registry.featured === null) registry.featured = manifest.pool;
  }
  await saveRegistry(registry);
}

async function importBundle() {
  const file = flag('bundle');
  if (!file) throw Error('Use import --bundle <saved FLURBO_PRACTICE_COLLECTIONS_JSON file>');
  if (await exists(REGISTRY)) throw Error('config/collections.json already exists; edit it with register or set');
  const rows = await json(resolve(file)), mode = flag('settlement') ?? 'finish-only';
  if (!Array.isArray(rows) || !SETTLEMENT_MODES.includes(mode)) throw Error('Invalid bundle or settlement mode');
  const registry = emptyRegistry();
  registry.collections = rows.map((r: any) => ({ label: r.label, settlement: mode, status: 'active', manifest: r.manifest }));
  registry.featured = flag('featured') ?? rows.at(-1)?.manifest.pool ?? null;
  await saveRegistry(registry);
}

async function set() {
  const [target, change] = rest;
  if (!target || !change) throw Error('Use set <pool or label> settlement=<mode> | status=<status> | featured');
  const registry = await json(REGISTRY);
  const row = registry.collections.find((r: any) => r.manifest.pool === target.toLowerCase() || r.label === target);
  if (!row) throw Error(`No collection ${target}`);
  const [key, value] = change.split('=');
  if (key === 'featured' && value === undefined) registry.featured = row.manifest.pool;
  else if (key === 'settlement' && SETTLEMENT_MODES.includes(value)) row.settlement = value;
  else if (key === 'status' && REGISTRY_STATUSES.includes(value)) {
    row.status = value;
    if (value === 'retired' && registry.featured === row.manifest.pool) registry.featured = registry.collections.find((r: any) => r.status === 'active')?.manifest.pool ?? null;
  } else throw Error('Unknown change');
  await saveRegistry(registry);
}

const commands: Record<string, () => Promise<void>> = { prepare, check, verify, register, import: importBundle, set };
if (!commands[command]) throw Error(`Use one of: ${Object.keys(commands).join(', ')}`);
await commands[command]();
