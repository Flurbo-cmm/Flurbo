import { mkdir, writeFile } from 'node:fs/promises';
import { preparePreTestV2 as preparePreTest } from '../src/pre-test-v2';
// Starts immutable deadlines: trading closes about 95 minutes after this runs. Run it only when you are ready to deploy.
const args = process.argv.slice(2);
if (args[0] !== '--prepare' || (args.length !== 1 && !(args.length === 3 && args[1] === '--closes-at'))) {
  throw Error('Run with --prepare [--closes-at <unix seconds>] when the deployer is funded and ready. This starts immutable deadlines.');
}
const root = new URL('../../../', import.meta.url), now = Math.floor(Date.now() / 1000);
const selection = await Bun.file(new URL('config/pilot-alpha-selection.json', root)).json();
const destination = new URL('target/deployments/pre-test-v2-prepared.json', root);
await mkdir(new URL('target/deployments/', root), { recursive: true });
let prepared;
if (await Bun.file(destination).exists()) {
  const previous = await Bun.file(destination).json();
  prepared = preparePreTest(selection, now, previous.publication.draft.closesAt);
  if (prepared.configHash !== previous.configHash) throw Error('An earlier pre-test-v2 preparation differs. Keep it, or move it aside before preparing another.');
} else {
  prepared = preparePreTest(selection, now, args[2] ? Number(args[2]) : undefined);
  await writeFile(destination, JSON.stringify(prepared, null, 2) + '\n', { flag: 'wx' });
}
const t = (s: number) => new Date(s * 1000).toISOString().replace('.000Z', 'Z');
console.log(JSON.stringify({ status: prepared.status, draftHash: prepared.draftHash, configHash: prepared.configHash, liquidityAtoms: prepared.liquidityAtoms,
  tradeCloses: t(prepared.publication.draft.closesAt),
  questions: prepared.publication.settlementRules!.map((r: any) => ({ event: r.eventId, captureOpens: t(r.timing.scheduledAt), captureCloses: t(r.timing.publicationCutoff),
    earliestFinal: t(r.timing.observationEndsAt + 3600) })),
  next: 'Deploy with DeployPreTestV2 before trading closes, then verify with --pre-test-v2.' }, null, 2));
