import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, extname, resolve } from 'node:path';
import { createPublicClient, createWalletClient, http, keccak256, encodeFunctionData, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// Local development stack for agent tests and the acceptance demonstration. Everything runs on this machine:
//   an anvil chain with chain id 10143, local test AUSD (6 decimals) at the canonical test AUSD address,
//   a Multicall3 stand-in at the canonical address, a funded pilot pool and resolver, its manifest,
//   and the real Flurbo API (and built dashboard, when present) using that deployment.
// Never points at a public network. The keys below are anvil's public development keys.
const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const artifact = (file: string, name: string) => JSON.parse(readFileSync(join(repo, 'target/foundry/out', file, `${name}.json`), 'utf8'));
export const AUSD = '0xa9012a055bd4e0edff8ce09f960291c09d5322dc';
export const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
export const CREATOR_KEY = '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6' as Hex; // anvil account 9
export const REVIEWERS = ['0xa0Ee7A142d267C1f36714E4a8F75612F20a79720', '0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f', '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955'];
const erc20 = parseAbi(['function mint(address,uint256)', 'function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);

export type LocalStack = {
  rpcUrl: string; apiUrl: string; manifest: any; manifestPath: string;
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
  const now = Number((await pub.getBlock()).timestamp), closesAt = now + (o.closesInSeconds ?? 7 * 86_400);
  const events = [
    { id: 'local-release-a', question: 'Will local project A publish release 1.0 before the observation deadline?', yesRule: 'YES if the release page lists a stable 1.0 release published before the deadline.', noRule: 'NO otherwise.' },
    { id: 'local-release-b', question: 'Will local project B publish release 2.0 before the observation deadline?', yesRule: 'YES if the release page lists a stable 2.0 release published before the deadline.', noRule: 'NO otherwise.' },
  ];
  const resolverArtifact = artifact('PilotResolver.sol', 'PilotResolver');
  const config = { collateral: AUSD, draftHash: keccak256('0x6c6f63616c2d6167656e742d64726166742d7631'), closesAt: BigInt(closesAt),
    eventHashes: events.map(e => keccak256(`0x${Buffer.from(e.id).toString('hex')}`)), observationEnds: events.map(() => BigInt(closesAt + 86_400)),
    reviewers: REVIEWERS, bond: 1_000_000n, assertionPeriod: 3600, challengePeriod: 3600, votingPeriod: 3600 };
  const resolver = await deploy('PilotResolver.sol', 'PilotResolver', [config]);
  const rulesHash = await pub.readContract({ address: resolver as Hex, abi: resolverArtifact.abi, functionName: 'rulesHash' }) as Hex;
  const pool = await deploy('PilotPool.sol', 'PilotPool', [AUSD, events.length, 10_000_000n, BigInt(closesAt), events.map((_, i) => i), resolver, rulesHash]);
  await send(resolver, resolverArtifact.abi, 'bindPool', [pool]);
  const poolAbi = artifact('PilotPool.sol', 'PilotPool').abi;
  const funding = await pub.readContract({ address: pool as Hex, abi: poolAbi, functionName: 'requiredFunding' }) as bigint;
  await send(AUSD, erc20, 'mint', [creator.address, funding]);
  await send(AUSD, erc20, 'approve', [pool, funding]);
  await send(pool, poolAbi, 'fund', []);
  // Deployment used instant mining; from here blocks arrive every second, as the read service expects fresh heads.
  await rpc('evm_setIntervalMining', [1]);
  const anchor = await pub.getBlock();
  const hashes: Record<string, string> = {};
  for (const address of [pool, resolver]) hashes[address] = keccak256(await rpc('eth_getCode', [address, 'latest']));
  const sources = o.eventSources ?? [];
  const manifest = {
    schema: 'flurbo.pilot-manifest.v1', status: 'verified_pilot_snapshot', chainId: 10143, pool, resolver, rulesHash: rulesHash.toLowerCase(), draftHash: config.draftHash,
    publication: { schema: 'flurbo.pilot-publication.v1', creator: creator.address.toLowerCase(),
      draft: { schema: 'flurbo.event-draft.v1', status: 'draft', chainId: 10143, clusterId: 'local-agent-test', title: 'Local agent test market (anvil, test assets)', closesAt,
        events: events.map((e, i) => ({ ...e, observationStartsAt: closesAt + 60, observationEndsAt: closesAt + 86_400,
          source: sources[i] ? { publisher: 'local evidence server', referenceUrl: sources[i], recordId: e.id } : undefined })),
        exceptionPolicy: 'Local test only.', disputeModel: 'reviewer-panel', disputePolicy: 'Local test only.' },
      reviewers: REVIEWERS.map((address, i) => ({ name: `Local reviewer ${i + 1}`, address: address.toLowerCase() })), reviewerControl: 'single-operator',
      independentReviewersConfirmed: false, rulesReviewed: true, bondAtoms: '1000000', assertionPeriod: 3600, challengePeriod: 3600, votingPeriod: 3600 },
    verifiedBlock: anchor.number.toString(), verifiedBlockHash: anchor.hash!.toLowerCase(), verifiedTimestamp: Number(anchor.timestamp), codeHashes: hashes,
  };
  const dir = join(repo, 'target', 'agent-local'), manifestPath = join(dir, 'pilot-manifest.json');
  mkdirSync(dir, { recursive: true }); writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // The real Flurbo API against this deployment, with in-memory sessions and no invite gate.
  // Test-only independent Boolean fixtures, not metadata for any public deployment.
  const previousSemanticRules=process.env.FLURBO_SEMANTIC_RULES_JSON;
  process.env.FLURBO_SEMANTIC_RULES_JSON=JSON.stringify({schema:'flurbo.semantic-rules.v1',markets:[{pool:manifest.pool,rulesHash:manifest.rulesHash,
    predicates:manifest.publication.draft.events.map((_:unknown,event:number)=>({event,observation:`local-fixture:${event}`,operator:'gte',value:'1',sourceRule:'Local synthetic fixture: a separate Boolean observation for each test event.'}))}]});
  const { localApi } = await import(pathOf('apps/web/server/local-api.mjs'));
  const { pilotService, pilotRpc } = await import(pathOf('apps/web/server/pilot.mjs'));
  const { claimAnalytics } = await import(pathOf('apps/web/server/claim-analytics.mjs'));
  const pilot = pilotService({ manifest, rpc: pilotRpc(rpcUrl, fetch, { allowLocal: true }) });
  try { pilot.claimAnalytics = claimAnalytics({ service: pilot, rpc: pilotRpc(rpcUrl, fetch, { allowLocal: true }) }); } catch { /* optional */ }
  const hosts = [`localhost:${apiPort}`, `127.0.0.1:${apiPort}`];
  const middleware = localApi({ hosts, rpcUrl, pilot });
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
    rpcUrl, apiUrl, manifest, manifestPath,
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
