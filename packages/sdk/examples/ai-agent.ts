// An AI agent running on your machine: it reads each market's questions, rules, deadline and published
// sources, retrieves evidence from allowlisted hosts, asks a real model provider for a structured joint
// forecast, validates it, compares it with the pool's executable quotes, applies your policy and, in live
// mode, signs and sends the trade with the agent wallet key. No browser, no MetaMask confirmation.
//
//   node packages/sdk/examples/ai-agent.ts flurbo-agent.json [--once]
//
// Configure research.provider in the file, for example:
//   { "kind": "openai-compatible", "baseUrl": "https://api.openai.com/v1", "model": "<model id>", "apiKeyEnv": "OPENAI_API_KEY" }
//   { "kind": "anthropic", "model": "<model id>", "apiKeyEnv": "ANTHROPIC_API_KEY" }
//   { "kind": "openai-compatible", "baseUrl": "http://127.0.0.1:11434/v1", "model": "<local model>", "apiKeyEnv": null }   (a local model server)
// Check your provider's current terms and prices; this example does not assume any provider is free.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { agentRunner, parseConfig } from '../src/node/runner.ts';

const path = resolve(process.argv[2] ?? 'flurbo-agent.json');
const config = parseConfig(JSON.parse(readFileSync(path, 'utf8')));
const provider = config.research.provider, problems: string[] = [];
if (provider.kind === 'none') problems.push('research.provider is not configured, so the agent would only abstain.');
if (provider.kind === 'fixture') problems.push('research.provider is a fixture. This example needs a real model provider; a fixed reply is not AI.');
if ((provider.kind === 'openai-compatible' || provider.kind === 'anthropic') && provider.apiKeyEnv && !process.env[provider.apiKeyEnv]) problems.push(`${provider.apiKeyEnv} is not set for the model provider.`);
if (!process.env[config.api.credentialEnv]) problems.push(`${config.api.credentialEnv} is not set (issue an agent credential on the agent page).`);
if (config.mode === 'live' && !process.env[config.signer.keyEnv]) problems.push(`${config.signer.keyEnv} is not set (the dedicated agent wallet key; live mode only).`);
if (problems.length) { console.error('Not starting:\n  ' + problems.join('\n  ')); process.exit(1); }
console.log(`Starting in ${config.mode} mode with ${provider.kind} research. Stop with Ctrl+C or "flurbo-agent stop".`);
const runner = agentRunner({ config: { ...config, stateDir: resolve(path, '..', config.stateDir) } });
process.once('SIGINT', () => runner.requestStop());
await runner.run({ once: process.argv.includes('--once') });
