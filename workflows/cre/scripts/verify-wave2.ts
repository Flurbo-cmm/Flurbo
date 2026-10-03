import { verifyPilot } from '../src/pilot-verification';

const args = process.argv.slice(2);
if(args.length !== 1 || !['--wave2-f2', '--wave2-f3'].includes(args[0])) {
  throw new Error('Use --wave2-f2 or --wave2-f3');
}

const poolName = args[0] === '--wave2-f3' ? 'wave2-f3' : 'wave2-f2';
const root = new URL('../../../', import.meta.url);

const prepared = await Bun.file(new URL(`target/deployments/${poolName}-prepared.json`, root)).json();
const deployment = await Bun.file(new URL(`target/deployments/${poolName}-unverified.json`, root)).json();

if (prepared.publication.mode !== 'deterministic-source-v1') throw new Error('Deterministic deployment mode mismatch');

const artifacts: Record<string, any> = {};
for (const name of ['PilotPool', 'PilotResolver', 'FactoredBaseTokenFactory', 'FactoredBaseToken']) {
  artifacts[name] = await Bun.file(new URL(`target/foundry/out/${name}.sol/${name}.json`, root)).json();
}

const endpoint = process.env.FLURBO_ALCHEMY_TESTNET_RPC_URL || 'https://testnet-rpc.monad.xyz';
if (!endpoint.startsWith('https://')) throw new Error('HTTPS RPC required');

const rpc = async (method: string, params: unknown[]) => {
  const response = await fetch(endpoint, {
    method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error('RPC request failed');
  const result = await response.json() as { error?: unknown; result?: unknown };
  if (result.error || result.result === undefined) throw new Error(`RPC rejected ${method}`);
  return result.result;
};

const manifest = await verifyPilot(prepared, deployment, rpc, artifacts, Math.floor(Date.now() / 1000));
await Bun.write(new URL(`target/deployments/${poolName}-testnet.json`, root), JSON.stringify(manifest, null, 2) + '\n');

console.log(JSON.stringify({ status: manifest.status, mode: manifest.publication.mode, block: manifest.verifiedBlock, pool: manifest.pool }));
