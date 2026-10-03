import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FlurboError } from '../errors.ts';
import { isNamespace } from '../market.ts';
import { agentRunner, defaultConfig, parseConfig } from './runner.ts';
import { signerFromEnv } from './signer.ts';

// flurbo-agent: a local runner for an agent on the operator's own infrastructure. It never uploads keys,
// prints secrets or runs anything on Flurbo's servers. Closing the Flurbo dashboard does not stop it;
// `stop` (or Ctrl+C) does.
const HELP = `flurbo-agent <command> [--config flurbo-agent.json]

  init [--markets A,B] Write a configuration template (paper mode, no secrets). --markets sets the
                       markets the agent trades; its page on Flurbo shows the exact command.
  start [--once]       Run the agent loop in the foreground. --once runs a single cycle.
  stop                 Ask a running agent to stop after its current step.
  status               Show mode, pending transactions and the last run.
  recover              Reconcile and report existing transactions only. Starts nothing new.
  address              Print the agent wallet address from the key variable.
  sign-message --file F  Sign a Flurbo wallet association message with the agent key.

Secrets come only from environment variables named in the configuration:
  api.credentialEnv (default FLURBO_AGENT_TOKEN), signer.keyEnv (default FLURBO_AGENT_PRIVATE_KEY),
  and the model provider key variable if one is configured.`;

export async function main(argv: string[], io = { out: (s: string) => console.log(s), err: (s: string) => console.error(s) }): Promise<number> {
  const [command, ...rest] = argv;
  const flag = (name: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const configPath = resolve(flag('--config') ?? 'flurbo-agent.json');
  const load = () => {
    if (!existsSync(configPath)) throw new FlurboError('invalid_input', `No configuration at ${configPath}. Run "flurbo-agent init" first.`);
    const config = parseConfig(JSON.parse(readFileSync(configPath, 'utf8')));
    return { ...config, stateDir: resolve(configPath, '..', config.stateDir) };
  };
  try {
    switch (command) {
      case 'init': {
        if (existsSync(configPath)) throw new FlurboError('conflict', `${configPath} already exists.`);
        const config = defaultConfig(), markets = flag('--markets');
        if (markets !== undefined) {
          const list = markets.split(',').map(m => m.trim()).filter(Boolean);
          if (!list.length || !list.every(isNamespace)) throw new FlurboError('invalid_input', 'Pass --markets as the comma separated market names shown on the agent page: pilot, or practice- followed by the pool address without 0x.');
          config.markets = list; config.policy = { ...config.policy, markets: list };
          parseConfig(config);
        }
        writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
        io.out(`Wrote ${configPath} (paper mode, markets ${config.markets.join(', ')}). Set FLURBO_AGENT_TOKEN, and FLURBO_AGENT_PRIVATE_KEY for live mode, in your environment. Never put them in the file.`);
        return 0;
      }
      case 'start': {
        const runner = agentRunner({ config: load() });
        const onSignal = () => { io.err('Stopping after the current step. Submitted transactions are still reconciled on the next start.'); runner.requestStop(); };
        process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
        await runner.run({ once: rest.includes('--once') });
        return 0;
      }
      case 'stop': { agentRunner({ config: { ...load(), mode: 'paper' } }).requestStop(); io.out('Stop requested. A running agent stops after its current step.'); return 0; }
      case 'status': { io.out(JSON.stringify(agentRunner({ config: load() }).status(), null, 2)); return 0; }
      case 'recover': { io.out(JSON.stringify(await agentRunner({ config: load() }).recover(), null, 2)); return 0; }
      case 'address': { const c = load(); io.out(signerFromEnv(c.signer.keyEnv).address); return 0; }
      case 'sign-message': {
        const file = flag('--file');
        if (!file) throw new FlurboError('invalid_input', 'Pass --file with the association message copied from the agent page.');
        const message = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');
        if (!message.startsWith('Flurbo agent wallet association\n')) throw new FlurboError('invalid_input', 'This is not a Flurbo agent wallet association message.');
        const c = load(), signer = signerFromEnv(c.signer.keyEnv);
        if (!message.includes(`Agent wallet: ${signer.address}\n`)) throw new FlurboError('invalid_input', `The message is for a different wallet than ${signer.address}.`);
        io.out(await signer.signMessage(message));
        return 0;
      }
      default: io.out(HELP); return command ? 1 : 0;
    }
  } catch (e) {
    io.err(e instanceof FlurboError ? `${e.code}: ${e.message}` : 'Unexpected error. Nothing new was sent.');
    return 1;
  }
}
