// Test helper for the Python, Rust and C++ SDKs: starts the local stack, sets up one agent through the real
// dashboard API (sign-in, runtime agent, credential, associated and funded wallet, live allowed) and prints
// one JSON line with what a runtime needs. Then each stdin line {"method","path","body"} is sent to the
// dashboard API with the owner's session, and the response is printed as one JSON line. Closing stdin stops it.
//   node packages/sdk/tools/serve-local-stack.ts [--rpc-port N] [--api-port N]
import { createInterface } from 'node:readline';
import { generatePrivateKey } from 'viem/accounts';
import { startLocalStack } from './local-stack.ts';
import { localKeySigner } from '../src/node/signer.ts';

const arg = (name: string, fallback: number) => { const i = process.argv.indexOf(name); return i > 0 ? Number(process.argv[i + 1]) : fallback; };
const stack = await startLocalStack({ rpcPort: arg('--rpc-port', 19145), apiPort: arg('--api-port', 19167), serveDashboard: false });
try {
  const cookie = await stack.signIn(generatePrivateKey());
  const agent = (await stack.api('/api/agents', { cookie, body: { kind: 'runtime', name: 'Cross-language agent', markets: ['pilot'] } })).body;
  const token = (await stack.api(`/api/agents/${agent.id}/credentials`, { cookie, body: { scopes: ['markets:read', 'wallet:read', 'runtime:report', 'executions:report'] } })).body.token;
  const agentKey = generatePrivateKey(), signer = localKeySigner(agentKey);
  const challenge = (await stack.api(`/api/agents/${agent.id}/wallet/challenge`, { cookie, body: { wallet: signer.address } })).body;
  await stack.api(`/api/agents/${agent.id}/wallet/verify`, { cookie, body: { id: challenge.id, signature: await signer.signMessage(challenge.message) } });
  await stack.setNativeBalance(signer.address, 10n ** 19n); await stack.mint(signer.address, 20_000_000n);
  await stack.api(`/api/agents/${agent.id}/runtime-policy`, { cookie, body: { liveEnabled: true } });
  console.log(JSON.stringify({ ready: true, rpcUrl: stack.rpcUrl, apiUrl: stack.apiUrl, agentId: agent.id, token, agentKey, wallet: signer.address, pool: stack.manifest.pool }));
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); console.log(JSON.stringify(await stack.api(r.path.replace('{agent}', agent.id), { cookie, method: r.method, body: r.body ?? undefined }))); }
    catch (e) { console.log(JSON.stringify({ status: 0, body: { error: String((e as Error).message) } })); }
  }
} finally { await stack.stop(); }
