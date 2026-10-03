import { cre, decodeJson, Runner, type HTTPPayload, type Runtime } from "@chainlink/cre-sdk";
import { configSchema, prepareSettlement, type Config } from "./settlement";

function onSyntheticTrigger(runtime: Runtime<Config>, payload: HTTPPayload): string {
  const result = prepareSettlement(runtime.config, decodeJson(payload.input),
    Math.floor(runtime.now().getTime() / 1000));
  runtime.log(`SYNTHETIC ONLY: terminal state ${result.terminalState}; unsigned ABI payload; no delivery`);
  return JSON.stringify(result);
}

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(() => [cre.handler(new cre.capabilities.HTTPCapability().trigger({}), onSyntheticTrigger)]);
}

main();
