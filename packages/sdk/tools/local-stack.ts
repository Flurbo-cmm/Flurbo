import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, extname, resolve } from 'node:path';
import { createPublicClient, createWalletClient, decodeAbiParameters, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// Local development stack for agent tests and the acceptance demonstration. Everything runs on this machine:
//   an anvil chain with chain id 10143, local test AUSD (6 decimals) at the canonical test AUSD address,
//   a Multicall3 stand-in at the canonical address, a funded hybrid pool (LsPilotPool with a HybridPilotResolver and two
//   mechanical questions) served as an agent pool, and the real Flurbo API (and built dashboard, when present) using it.
// Never points at a public network. The keys below are anvil's public development keys.
const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const artifact = (file: string, name: string) => JSON.parse(readFileSync(join(repo, 'target/foundry/out', file, `${name}.json`), 'utf8'));
export const AUSD = '0xa9012a055bd4e0edff8ce09f960291c09d5322dc';
export const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
export const CREATOR_KEY = '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6' as Hex; // anvil account 9
export const REVIEWERS = ['0xa0Ee7A142d267C1f36714E4a8F75612F20a79720', '0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f', '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955'];
const erc20 = parseAbi(['function mint(address,uint256)', 'function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);

export type LocalStack = {
  rpcUrl: string; apiUrl: string; manifest: any; manifestPath: string; namespace: string;
  mint(to: string, atoms: bigint): Promise<void>; setNativeBalance(to: string, wei: bigint): Promise<void>;
  signIn(key: Hex): Promise<string>; api(path: string, init?: { method?: string; body?: unknown; cookie?: string }): Promise<{ status: number; body: any }>;
  mineUntil(timestamp: number): Promise<void>; stop(): Promise<void>;
};

async function waitFor(url: string) {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) }); if (r.ok) return; } catch { /* starting */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('anvil did not start');
}

export async function startLocalStack(o: { rpcPort?: number; apiPort?: number; closesInSeconds?: number; eventSources?: string[]; serveDashboard?: boolean; quiet?: boolean } = {}): Promise<LocalStack> {
  const rpcPort = o.rpcPort ?? 18545, apiPort = o.apiPort ?? 18767, rpcUrl = `http://127.0.0.1:${rpcPort}`;
  const anvil: ChildProcess = spawn('anvil', ['--chain-id', '10143', '--port', String(rpcPort), '--silent'], { stdio: 'ignore', windowsHide: true });
  await waitFor(rpcUrl);
  const rpc = async (method: string, params: unknown[]) => { const r = await (await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (r.error) throw new Error(r.error.message); return r.result; };
  const chain = { id: 10143, name: 'local monad testnet', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } } as const;
  const pub = createPublicClient({ chain, transport: http(rpcUrl) }), creator = privateKeyToAccount(CREATOR_KEY);
  const wallet = createWalletClient({ chain, transport: http(rpcUrl), account: creator });
  const deploy = async (file: string, name: string, args: unknown[] = []) => {
    const a = artifact(file, name);
    const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args } as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    return r.contractAddress!.toLowerCase();
  };
  const send = async (to: string, abi: any, functionName: string, args: unknown[]) => pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: to as Hex, abi, functionName, args } as never) });
  // Canonical addresses: copy runtime code (immutables included) from normal deployments.
  const collateral = await deploy('MockCollateral.sol', 'MockCollateral', [6]);
  await rpc('anvil_setCode', [AUSD, await rpc('eth_getCode', [collateral, 'latest'])]);
  const multicall = await deploy('LocalMulticall3.sol', 'LocalMulticall3');
  await rpc('anvil_setCode', [MULTICALL3, await rpc('eth_getCode', [multicall, 'latest'])]);
  const now = Number((await pub.getBlock()).timestamp), closesAt = now + (o.closesInSeconds ?? 7 * 86_400), observationEndsAt = closesAt + 86_400;
  const { prepareHybridPilot, hybridRulesHash, hybridConfigAbi } = await import(pathOf('apps/web/scripts/prepare-hybrid-pilot.mjs'));
  // Two mechanical questions: no Sepolia or Kleros leg is needed to trade, and the trading ABI is the deployed one.
  // The creator is REVIEWERS[0] (anvil account 9), so the proposer and relay are the next two accounts.
  const rule = (id: string, question: string) => ({ schema: 'flurbo.settlement-rule.v1', eventId: id, question,
    source: { id: `local-${id}`, publisher: 'Local test publisher', urls: [`https://data.example.org/${id}`], adapter: 'json-api.v1',
      reader: { select: '/value', aggregate: 'value' } },
    observation: { series: id, period: '2027-01', unit: 'units' },
    decision: { type: 'number', operator: 'gte', value: '4' },
    timing: { scheduledAt: observationEndsAt - 3600, publicationCutoff: observationEndsAt, correctionCutoff: observationEndsAt, observationEndsAt,
      assertionPeriod: 3600, challengePeriod: 3600, votingPeriod: 3600 },
    vintage: 'first-observed-snapshot', missingPolicy: 'resolver-timeout-void' });
  const events = [
    { id: 'local-release-a', question: 'Will local project A publish release 1.0 before the observation deadline?' },
    { id: 'local-release-b', question: 'Will local project B publish release 2.0 before the observation deadline?' },
  ].map(e => ({ ...e, observationEndsAt, route: 'mechanical', rule: rule(e.id, e.question) }));
  const prepared = prepareHybridPilot({ schema: 'flurbo.hybrid-publication.v5', chainId: 10143, rulesReviewed: true, creator: creator.address,
    proposer: REVIEWERS[1], relay: REVIEWERS[2], title: 'Local agent test market (anvil, test assets)', closesAt,
    assertionPeriod: 3600, challengePeriod: 3600, reportPeriod: 3600, arbitrationPeriod: 30 * 86_400, bondAtoms: '1000000', liquidityAtoms: '10000000', commissionBps: 500, events });
  const config = decodeAbiParameters(hybridConfigAbi, prepared.resolverConfig)[0];
  const resolverArtifact = artifact('HybridPilotResolver.sol', 'HybridPilotResolver');
  const resolver = await deploy('HybridPilotResolver.sol', 'HybridPilotResolver', [config]);
  const rulesHash = (await pub.readContract({ address: resolver as Hex, abi: resolverArtifact.abi, functionName: 'rulesHash' }) as Hex).toLowerCase();
  // The commitment the server computes must be the one the contract stores.
  if (rulesHash !== hybridRulesHash(prepared, resolver).toLowerCase()) throw new Error('local hybrid rules hash differs from the contract');
  const pool = await deploy('LsPilotPool.sol', 'LsPilotPool', [AUSD, events.length, 10_000_000n, 500, BigInt(closesAt), events.map((_, i) => i), resolver, rulesHash]);
  await send(resolver, resolverArtifact.abi, 'bindPool', [pool]);
  const poolAbi = artifact('LsPilotPool.sol', 'LsPilotPool').abi;
  const funding = await pub.readContract({ address: pool as Hex, abi: poolAbi, functionName: 'requiredFunding' }) as bigint;
  await send(AUSD, erc20, 'mint', [creator.address, funding]);
  await send(AUSD, erc20, 'approve', [pool, funding]);
  await send(pool, poolAbi, 'fund', []);
  // Deployment used instant mining; from here blocks arrive every second, as the read service expects fresh heads.
  await rpc('evm_setIntervalMining', [1]);
  const anchor = await pub.getBlock();
  const { agentNamespace, hybridPoolManifest, hybridPoolService, readHybridPoolAnchor } = await import(pathOf('apps/web/server/hybrid-pool-service.mjs'));
  const { poolRpc } = await import(pathOf('apps/web/server/pool-rpc.mjs'));
  const chainRpc = poolRpc(rpcUrl, fetch, { allowLocal: true });
  const record = { id: 'local-agent-test', pool, resolver, rulesHash, deploymentBlock: Number(anchor.number), prepared };
  const manifest = hybridPoolManifest(record, await readHybridPoolAnchor({ record, rpc: chainRpc }));
  (o.eventSources ?? []).forEach((url, i) => { if (url && manifest.publication.draft.events[i])
    manifest.publication.draft.events[i].source = { publisher: 'local evidence server', referenceUrl: url, recordId: manifest.publication.draft.events[i].id }; });
  const dir = join(repo, 'target', 'agent-local'), manifestPath = join(dir, 'pool-manifest.json');
  mkdirSync(dir, { recursive: true }); writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // The real Flurbo API against this deployment, with in-memory sessions and no invite gate.
  // Test-only independent Boolean fixtures, not metadata for any public deployment.
  const previousSemanticRules=process.env.FLURBO_SEMANTIC_RULES_JSON;
  process.env.FLURBO_SEMANTIC_RULES_JSON=JSON.stringify({schema:'flurbo.semantic-rules.v1',markets:[{pool:manifest.pool,rulesHash:manifest.rulesHash,
    predicates:manifest.publication.draft.events.map((_:unknown,event:number)=>({event,observation:`local-fixture:${event}`,operator:'gte',value:'1',sourceRule:'Local synthetic fixture: a separate Boolean observation for each test event.'}))}]});
  const { localApi } = await import(pathOf('apps/web/server/local-api.mjs'));
  const { claimAnalytics } = await import(pathOf('apps/web/server/claim-analytics.mjs'));
  const { pairAnalytics } = await import(pathOf('apps/web/server/pair-analytics.mjs'));
  const service = hybridPoolService({ manifest, rpc: chainRpc });
  try { service.claimAnalytics = claimAnalytics({ service, rpc: chainRpc }); service.analytics = pairAnalytics({ service, rpc: chainRpc }); } catch { /* optional */ }
  const namespace: string = agentNamespace(pool);
  const agentPools = { collections: [{ namespace, label: manifest.publication.draft.title, pool, closesAt }], services: new Map([[namespace, service]]), reservedAddresses: new Set<string>() };
  const hosts = [`localhost:${apiPort}`, `127.0.0.1:${apiPort}`];
  const middleware = localApi({ hosts, rpcUrl, agentPools });
  const dist = join(repo, 'apps/web/dist'), types: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
  const server: Server = createServer((req, res) => middleware(req, res, () => {
    const path = new URL(req.url ?? '/', 'http://x').pathname, file = join(dist, path.startsWith('/assets/') ? path : 'index.html');
    if ((o.serveDashboard ?? true) && existsSync(file)) { res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' }); res.end(readFileSync(file)); }
    else { res.writeHead(404); res.end(); }
  }));
  await new Promise<void>(r => server.listen(apiPort, '127.0.0.1', r));
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  async function api(path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) {
    const r = await fetch(apiUrl + path, { method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { Origin: apiUrl, ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(init.cookie ? { Cookie: init.cookie } : {}) }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
  }
  return {
    rpcUrl, apiUrl, manifest, manifestPath, namespace,
    async mint(to, atoms) { await send(AUSD, erc20, 'mint', [to, atoms]); },
    async setNativeBalance(to, wei) { await rpc('anvil_setBalance', [to, '0x' + wei.toString(16)]); },
    // Local sign-in through the real login endpoints, with a local test identity key.
    async signIn(key) {
      const account = privateKeyToAccount(key);
      const challenge = await fetch(apiUrl + '/api/auth/challenge', { method: 'POST', headers: { Origin: apiUrl, 'Content-Type': 'application/json' }, body: JSON.stringify({ address: account.address }) });
      const challengeCookie = (challenge.headers.get('set-cookie') ?? '').split(';')[0], { message } = await challenge.json();
      const verify = await fetch(apiUrl + '/api/auth/verify', { method: 'POST', headers: { Origin: apiUrl, 'Content-Type': 'application/json', Cookie: challengeCookie }, body: JSON.stringify({ signature: await account.signMessage({ message }) }) });
      const cookie = (verify.headers.get('set-cookie') ?? '').split(/,(?=\s*flurbo_)/).map(c => c.split(';')[0].trim()).find(c => c.startsWith('flurbo_session='));
      if (!cookie || !verify.ok) throw new Error('local sign-in failed');
      return cookie;
    },
    api,
    async mineUntil(timestamp) { await rpc('evm_setNextBlockTimestamp', ['0x' + timestamp.toString(16)]); await rpc('evm_mine', []); },
    async stop() { await new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }); anvil.kill();
      if(previousSemanticRules===undefined)delete process.env.FLURBO_SEMANTIC_RULES_JSON;else process.env.FLURBO_SEMANTIC_RULES_JSON=previousSemanticRules;
    },
  };
}
const pathOf = (p: string) => new URL(`file:///${join(repo, p).replace(/\\/g, '/')}`).href;
