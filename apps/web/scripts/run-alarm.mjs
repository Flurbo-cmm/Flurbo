import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { alarmConfig, alarmPoolsFromManifests, alarmTick, githubActions, jsonRpc } from '../server/settlement-alarm.mjs';

// Local or scheduled alarm runner. Report-only by default: it dispatches only with --dispatch AND
// FLURBO_ALARM_GITHUB_TOKEN, and pings Healthchecks only with --ping AND FLURBO_ALARM_HEALTHCHECK_URL.
// Without a token it can still list public run history.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const json = async path => JSON.parse(await readFile(resolve(root, path), 'utf8'));

export async function localAlarmConfig(env = process.env) {
  if (env.FLURBO_ALARM_CONFIG_JSON) return alarmConfig(JSON.parse(env.FLURBO_ALARM_CONFIG_JSON));
  const bundle = await json('target/deployments/showcase-v0-collections.json');
  const manifests = [await json('config/pilot-testnet.json'), ...bundle.map(r => r.manifest || r)];
  return alarmConfig({ repository: 'Singularityy0/Flurbo', monitorWorkflow: 'settlement-monitor.yml', workerWorkflow: 'resolution-worker.yml',
    signer: env.FLURBO_RESOLUTION_SIGNER_ADDRESS || '0x632a158d5eccc10f864ab94cec99511e1cc514f3',
    pools: alarmPoolsFromManifests(manifests, env.FLURBO_RESOLUTION_POOL || null) });
}

export async function runAlarm({ args = process.argv.slice(2), env = process.env, fetcher = fetch } = {}) {
  if (args.some(a => !['--dispatch', '--ping'].includes(a))) throw new Error('Use no arguments (report only), --dispatch and/or --ping');
  const config = await localAlarmConfig(env);
  const github = githubActions({ repository: config.repository, token: env.FLURBO_ALARM_GITHUB_TOKEN || null,
    monitorWorkflow: config.monitorWorkflow, workerWorkflow: config.workerWorkflow, fetcher });
  return alarmTick({ config, rpc: jsonRpc(env.FLURBO_ALARM_RPC_URL || 'https://testnet-rpc.monad.xyz', fetcher), github, fetcher,
    dispatch: args.includes('--dispatch') && !!env.FLURBO_ALARM_GITHUB_TOKEN,
    healthUrl: args.includes('--ping') ? env.FLURBO_ALARM_HEALTHCHECK_URL || null : null });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runAlarm().then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(() => { console.error(JSON.stringify({ action: 'alarm-failed', message: 'Configuration or runtime failure. Details withheld.' })); process.exitCode = 1; });
}
