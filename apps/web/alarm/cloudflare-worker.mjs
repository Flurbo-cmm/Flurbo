// Scheduled edge entry for the settlement alarm. NOT DEPLOYED. Activation requires an explicit
// decision, a dedicated GitHub token and wrangler.example.toml copied and reviewed.
// Bindings: FLURBO_ALARM_CONFIG_JSON (public config), FLURBO_ALARM_GITHUB_TOKEN (secret),
// FLURBO_ALARM_HEALTHCHECK_URL (secret capability URL, dedicated check), FLURBO_ALARM_DISPATCH ("true" to dispatch).
// Optional: FLURBO_ALARM_RPC_URL (public endpoint only; the alarm needs no private RPC).
import { alarmConfig, alarmTick, githubActions, healthPing, jsonRpc } from '../server/settlement-alarm.mjs';

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      const healthUrl = env.FLURBO_ALARM_HEALTHCHECK_URL || null;
      try {
        const config = alarmConfig(JSON.parse(env.FLURBO_ALARM_CONFIG_JSON));
        const github = githubActions({ repository: config.repository, token: env.FLURBO_ALARM_GITHUB_TOKEN,
          monitorWorkflow: config.monitorWorkflow, workerWorkflow: config.workerWorkflow });
        const result = await alarmTick({ config, rpc: jsonRpc(env.FLURBO_ALARM_RPC_URL || 'https://testnet-rpc.monad.xyz'),
          github, dispatch: env.FLURBO_ALARM_DISPATCH === 'true', healthUrl });
        console.log(JSON.stringify(result));
      } catch {
        // A broken configuration or runtime never heals itself: signal failure, never log secrets.
        const summary = { action: 'alarm-failed', reason: 'configuration-or-runtime' };
        console.log(JSON.stringify({ ...summary, healthPing: await healthPing({ url: healthUrl, health: 'fail', summary }) }));
      }
    })());
  },
};
