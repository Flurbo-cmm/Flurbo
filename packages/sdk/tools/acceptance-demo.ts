// Acceptance demonstration on this machine only: a local anvil chain (chain id 10143) with test assets,
// the real Flurbo API and an agent started from the command line, outside any browser.
//   node packages/sdk/tools/acceptance-demo.ts [--screenshot dashboard.png]
// With a real model provider: FLURBO_DEMO_BASE_URL, FLURBO_DEMO_MODEL and FLURBO_DEMO_API_KEY_ENV (the
// name of the variable holding the key). Without them the forecaster is a labelled fixture, not AI.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey } from 'viem/accounts';
import { startLocalStack } from './local-stack.ts';
import { defaultConfig, type AgentConfig } from '../src/node/runner.ts';
import { executor } from '../src/node/executor.ts';
import { FileJournal } from '../src/node/journal.ts';
import { chainReader } from '../src/node/chain.ts';
import { jsonRpc } from '../src/node/rpc.ts';
import { localKeySigner } from '../src/node/signer.ts';
import { runtimeClient } from '../src/node/headless.ts';
import { MODEL_SCHEMA } from '../src/research.ts';

const sdk = resolve(fileURLToPath(new URL('..', import.meta.url))), demo = resolve(sdk, '../../target/agent-demo');
const step = (n: number, title: string) => console.log(`\n=== ${n}. ${title}`);
const show = (label: string, value: unknown) => console.log(`  ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
rmSync(demo, { recursive: true, force: true }); mkdirSync(demo, { recursive: true });

// Local evidence the agent retrieves through its retrieval interface (plain HTTP on this machine only).
const pages: Record<string, string> = {
  '/project-a': '<html><title>Project A releases</title><p>Release candidate 1.0-rc3 tagged. Final 1.0 scheduled with project B on the same day.</p></html>',
  '/project-b': '<html><title>Project B releases</title><p>Release candidate 2.0-rc2 tagged. Joint release with project A planned; shared dependency pinned.</p></html>',
};
const evidence = createServer((req, res) => { const page = pages[req.url ?? '']; res.writeHead(page ? 200 : 404, { 'content-type': 'text/html', 'last-modified': new Date(Date.now() - 3_600_000).toUTCString() }); res.end(page ?? ''); });
await new Promise<void>(r => evidence.listen(0, '127.0.0.1', r));
const evidenceUrl = `http://127.0.0.1:${(evidence.address() as any).port}`;

step(1, 'Local chain, Flurbo API and evidence');
const stack = await startLocalStack({ eventSources: [`${evidenceUrl}/project-a`, `${evidenceUrl}/project-b`] });
show('chain', stack.rpcUrl); show('Flurbo API and dashboard', stack.apiUrl); show('pool', stack.manifest.pool);
try {
  step(2, 'Sign in, register the agent, link its wallet by ownership proof, issue a credential, fund the wallet');
  const cookie = await stack.signIn(generatePrivateKey());
  const agent = (await stack.api('/api/agents', { cookie, body: { kind: 'runtime', name: 'Demo relationship agent', markets: ['pilot'] } })).body;
  const agentKey = generatePrivateKey(), wallet = localKeySigner(agentKey).address;
  const env = { ...process.env, FLURBO_AGENT_PRIVATE_KEY: agentKey } as Record<string, string>;
  // A separate operating-system process, as an operator would run it. Asynchronous, because the Flurbo API
  // and the evidence server in this demo process must keep answering it.
  const cli = (args: string[], extraEnv: Record<string, string> = {}) => new Promise<{ code: number | null; out: string; err: string }>(done => {
    const child = spawn(process.execPath, [join(sdk, 'bin/flurbo-agent.ts'), ...args, '--config', join(demo, 'flurbo-agent.json')], { env: { ...env, ...extraEnv } });
    let out = '', err = '';
    child.stdout.on('data', c => out += c); child.stderr.on('data', c => err += c);
    child.on('exit', code => done({ code, out: out.trim(), err: err.trim() }));
  });
  const challenge = (await stack.api(`/api/agents/${agent.id}/wallet/challenge`, { cookie, body: { wallet } })).body;
  writeFileSync(join(demo, 'message.txt'), challenge.message);
  const provider = process.env.FLURBO_DEMO_BASE_URL && process.env.FLURBO_DEMO_MODEL
    ? { kind: 'openai-compatible' as const, baseUrl: process.env.FLURBO_DEMO_BASE_URL, model: process.env.FLURBO_DEMO_MODEL, apiKeyEnv: process.env.FLURBO_DEMO_API_KEY_ENV ?? null }
    : { kind: 'fixture' as const, replyFile: 'model-reply.json' };
  const config: AgentConfig = { ...defaultConfig(), api: { baseUrl: stack.apiUrl, credentialEnv: 'FLURBO_AGENT_TOKEN' }, chain: { rpcUrl: stack.rpcUrl }, stateDir: 'state', mode: 'live',
    schedule: { intervalSeconds: 30, heartbeatSeconds: 10, waitSeconds: 30 },
    research: { retriever: { kind: 'http', allowHosts: [], allowLocalHttp: true }, provider, perCycle: 2, perHour: 20, maxEvidenceAgeDays: 14 },
    policy: { ...defaultConfig().policy, minSecondsBeforeClose: 600 } };
  const writeConfig = (c: AgentConfig) => writeFileSync(join(demo, 'flurbo-agent.json'), JSON.stringify(c, null, 2));
  writeConfig(config);
  const reply = (statesPpm: number[]) => JSON.stringify({ schema: MODEL_SCHEMA, abstain: false, abstainReason: null, events: [0, 1], statesPpm, evidenceIds: ['src-1', 'src-2'],
    assumptions: ['Both projects share a release dependency.'], uncertainty: 'A late blocker in either project would split the releases.',
    explanation: 'Both release candidates are tagged and a joint release is planned, so both are likely and closely linked.' });
  writeFileSync(join(demo, 'model-reply.json'), reply([50_000, 50_000, 50_000, 850_000]));
  const signed = await cli(['sign-message', '--file', join(demo, 'message.txt')]);
  const verified = await stack.api(`/api/agents/${agent.id}/wallet/verify`, { cookie, body: { id: challenge.id, signature: signed.out } });
  show('wallet associated', verified.body.wallet);
  const token = (await stack.api(`/api/agents/${agent.id}/credentials`, { cookie, body: { scopes: ['markets:read', 'wallet:read', 'runtime:report', 'executions:report'], label: 'demo' } })).body.token;
  env.FLURBO_AGENT_TOKEN = token;
  show('credential', `${token.slice(0, 22)}... (shown once; only a digest is stored)`);
  await stack.api(`/api/agents/${agent.id}/runtime-policy`, { cookie, body: { liveEnabled: true } });
  await stack.setNativeBalance(wallet, 10n ** 19n); await stack.mint(wallet, 20_000_000n);
  show('funded', '10 MON for gas, 20 test AUSD');
  show('forecaster', provider.kind === 'fixture' ? 'FIXTURE reply file (not AI). Set FLURBO_DEMO_BASE_URL, FLURBO_DEMO_MODEL and FLURBO_DEMO_API_KEY_ENV for a real model.' : `${provider.baseUrl} ${provider.model}`);

  const chain = chainReader(jsonRpc(stack.rpcUrl)), journal = () => new FileJournal(join(demo, 'state'), wallet).read().entries;
  const detail = async () => (await stack.api(`/api/agents/${agent.id}`, { cookie })).body.runtime;

  step(3, 'Start the agent outside the browser: research, validated forecast, strategy, policy, signed trade');
  const run1 = await cli(['start', '--once']);
  for (const line of run1.out.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)) if (['execution', 'research_abstained', 'strategy_abstained'].includes(line.event)) show('runtime event', line);
  show('journal', journal().map(e => `${e.action} ${e.status} ${e.hash ?? ''}`));
  let rt = await detail();
  show('Flurbo decision', { outcome: rt.decisions[0].outcome, provenance: rt.decisions[0].provenance, evidence: rt.decisions[0].forecast?.evidence.map((e: any) => e.url), selfReported: rt.decisions[0].selfReported });
  show('Flurbo verified executions', rt.executions.map((e: any) => `${e.intent.action} ${e.status} ${e.verification?.collateralAtoms ?? ''}`));
  show('Flurbo verified totals', rt.totals);
  show('runtime connection', rt.connection.state);

  step(4, 'Restart around a pending transaction: signed, process gone before broadcast, then recover');
  const d = (await runtimeClient({ baseUrl: stack.apiUrl, token }).deployments())[0], signer = localKeySigner(agentKey), j = new FileJournal(join(demo, 'state'), wallet);
  const head = await chain.block(), quote = (await chain.quote(d.pool, 'buy', 3, 8n, 1_000_000n, head))!;
  const exec = executor({ chain, signer, journal: j, client: null, policy: () => config.policy, liveAllowed: () => ({ allowed: true, reason: null }) });
  // The earlier purchase used its exact approval, so approve first, as the runtime itself would.
  const approval = await exec.plan(d, { action: 'approve', amountAtoms: 2_000_000n }, 'demo-approval', null, 0);
  if ('entry' in approval) { const a = (await exec.sign(approval.entry.id, d))!; await exec.broadcast(a); for (let i = 0; i < 10 && journal().find(e => e.id === a.id)!.status !== 'confirmed'; i++) { await new Promise(r => setTimeout(r, 1000)); await exec.reconcileEntry(a.id); } }
  const planned = await exec.plan(d, { action: 'buy', claim: { scope: 3, mask: 8n }, quantityAtoms: 1_000_000n, limitAtoms: quote * 10_050n / 10_000n + 1n, deadline: head.timestamp + 300 }, 'demo-crash', head, 50);
  if (!('entry' in planned)) throw new Error('plan rejected: ' + JSON.stringify(planned));
  const pending = (await exec.sign(planned.entry.id, d))!;
  const nonceBefore = await chain.nonce(wallet, 'latest');
  show('signed but never sent', { hash: pending.hash, nonce: pending.nonce, status: pending.status });
  for (let i = 1; i <= 2; i++) { const r = await cli(['recover']); show(`recover run ${i}`, r.out.replace(/\s+/g, ' ')); await new Promise(r => setTimeout(r, 2500)); }
  await cli(['recover']);
  const after = journal().find(e => e.id === pending.id)!;
  show('after recovery', { hash: after.hash, status: after.status, sameHash: after.hash === pending.hash, noncesUsed: (await chain.nonce(wallet, 'latest')) - nonceBefore });

  step(5, 'Policy rejection: a per-trade limit below the price');
  writeConfig({ ...config, policy: { ...config.policy, maxTradeCostAtoms: '1000' } });
  const before5 = journal().length; await cli(['start', '--once']);
  rt = await detail();
  show('decision', { outcome: rt.decisions[0].outcome, reasons: rt.decisions[0].reasons }); show('new transactions', journal().length - before5);
  writeConfig(config);

  step(6, 'Abstention: the forecaster declines because the evidence conflicts');
  writeFileSync(join(demo, 'model-reply.json'), JSON.stringify({ schema: MODEL_SCHEMA, abstain: true, abstainReason: 'contradictory_evidence', explanation: 'The two release pages disagree on timing.' }));
  const before6 = journal().length; await cli(['start', '--once']);
  rt = await detail(); show('decision', { outcome: rt.decisions[0].outcome, reasons: rt.decisions[0].reasons }); show('new transactions', journal().length - before6);
  writeFileSync(join(demo, 'model-reply.json'), reply([50_000, 50_000, 50_000, 850_000]));

  step(7, 'Pause on the dashboard: the runtime starts nothing new');
  await stack.api(`/api/agents/${agent.id}/runtime-policy`, { cookie, body: { paused: true } });
  const before7 = journal().filter(e => e.status !== 'abandoned').length; await cli(['start', '--once']);
  rt = await detail(); show('decision', { outcome: rt.decisions[0].outcome, reasons: rt.decisions[0].reasons }); show('runtime state', rt.heartbeats[0].state); show('new transactions', journal().filter(e => e.status !== 'abandoned').length - before7);
  await stack.api(`/api/agents/${agent.id}/runtime-policy`, { cookie, body: { paused: false } });

  step(8, 'Credential revoked: the runtime stops starting actions');
  await stack.api(`/api/agents/${agent.id}/credentials/${rt.credentials[0].credentialId}/revoke`, { cookie, body: {} });
  const before8 = journal().length; const r8 = await cli(['start', '--once']);
  show('stopped', r8.out.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter((l: any) => l?.event === 'stopped_new_actions').map((l: any) => l.code));
  show('new transactions', journal().length - before8);
  show('status command', JSON.parse((await cli(['status'])).out).state);

  step(9, 'Summary');
  rt = (await stack.api(`/api/agents/${agent.id}`, { cookie })).body.runtime;
  show('verified purchases', `${rt.totals.buys} (paid ${rt.totals.buyCostAtoms} atoms)`);
  show('wallet holdings of the traded claim (on-chain)', (await chain.holdings(d.pool, wallet, 3, 8n)).toString());
  show('dashboard', `${stack.apiUrl}/agents/${agent.id} (sign-in is the local test identity used by this script)`);
  const shot = process.argv.indexOf('--screenshot');
  if (shot > 0 && process.env.FLURBO_TEST_PLAYWRIGHT) {
    const { chromium } = await import(new URL(`file:///${process.env.FLURBO_TEST_PLAYWRIGHT.replace(/\\/g, '/')}`).href);
    const browser = await chromium.launch({ headless: true, executablePath: process.env.FLURBO_TEST_BROWSER });
    const context = await browser.newContext({ viewport: { width: 1280, height: 1600 } });
    await context.addCookies([{ name: 'flurbo_session', value: cookie.split('=')[1], url: stack.apiUrl }]);
    const page = await context.newPage(); await page.goto(`${stack.apiUrl}/agents/${agent.id}`);
    await page.getByText('Verified trades').waitFor(); await page.screenshot({ path: resolve(process.argv[shot + 1]), fullPage: true }); await browser.close();
    show('screenshot', resolve(process.argv[shot + 1]));
  }
} finally { await stack.stop(); evidence.close(); }
console.log('\nDemo complete. State and configuration are in target/agent-demo.');
void readFileSync;
