import { mkdir, writeFile } from 'node:fs/promises';
import { prepareWave2F2, prepareWave2F3 } from '../src/wave2';

const args = process.argv.slice(2);
if (args[0] !== '--prepare' || !args[1] || !['f2', 'f3'].includes(args[1].toLowerCase())) {
  throw Error('Run with --prepare <f2|f3> [--closes-at <unix seconds>] when the deployer is funded and ready. This starts immutable deadlines.');
}

const poolName = args[1].toLowerCase();
const root = new URL('../../../', import.meta.url), now = Math.floor(Date.now() / 1000);
const selection = await Bun.file(new URL('config/pilot-alpha-selection.json', root)).json();
// F2 thresholds come from live prices on listing day; a missing file is an error.
const thresholds = poolName === 'f2' ? await Bun.file(new URL('config/wave2-thresholds.json', root)).json() : {};
const destination = new URL(`target/deployments/wave2-${poolName}-prepared.json`, root);
await mkdir(new URL('target/deployments/', root), { recursive: true });

let prepared;
if (await Bun.file(destination).exists()) {
  const previous = await Bun.file(destination).json();
  prepared = poolName === 'f3' ? prepareWave2F3(selection, now) : prepareWave2F2(selection, now, thresholds);
  if (prepared.configHash !== previous.configHash) throw Error(`An earlier wave2-${poolName} preparation differs. Keep it, or move it aside before preparing another.`);
} else {
  prepared = poolName === 'f3' ? prepareWave2F3(selection, now) : prepareWave2F2(selection, now, thresholds);
  await writeFile(destination, JSON.stringify(prepared, null, 2) + '\n', { flag: 'wx' });
}

const t = (s: number) => new Date(s * 1000).toISOString().replace('.000Z', 'Z');
console.log(JSON.stringify({ status: prepared.status, draftHash: prepared.draftHash, configHash: prepared.configHash, liquidityAtoms: prepared.liquidityAtoms,
  tradeCloses: t(prepared.publication.draft.closesAt),
  questions: prepared.publication.settlementRules!.map((r: any) => ({ event: r.eventId, captureOpens: t(r.timing.scheduledAt), captureCloses: t(r.timing.publicationCutoff),
    earliestFinal: t(r.timing.observationEndsAt + 3600) })),
  next: `Deploy with DeployWave2${poolName.toUpperCase()} before trading closes, then verify with --wave2-${poolName}.` }, null, 2));
