import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { settlementBot } from '../server/settlement-bot.mjs';

// Runs exactly one settlement bot cycle in this shell with transaction execution forced off.
// Load the values intended for the Render service into this shell, run it and read the
// [settlement-monitor] and [settlement-worker] lines. Nothing is signed or broadcast. The monitor
// still behaves normally: it records observations, may deliver pending alerts and pings the watchdog.
export async function runSettlementBotOnce({ env = process.env, log = console.log, factory = settlementBot } = {}) {
  let cycle = null;
  const bot = factory({ env: { ...env, FLURBO_RESOLUTION_EXECUTE: 'false' }, log, firstDelayMs: 0,
    schedule: fn => { cycle ??= fn; return 1; }, cancel: () => {} });
  bot.start();
  await cycle();
  bot.stop();
  return bot.status();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runSettlementBotOnce().then(status => console.log(JSON.stringify({ settlement_bot: status }, null, 2)))
    .catch(() => { console.error('{"error":"settlement-bot-once-failed","message":"Details withheld."}'); process.exitCode = 1; });
}
