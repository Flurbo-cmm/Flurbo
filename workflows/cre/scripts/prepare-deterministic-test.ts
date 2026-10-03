import { mkdir, writeFile } from 'node:fs/promises';
import { prepareDeterministicTest } from '../src/deterministic-test';
if (process.argv.length !== 3 || process.argv[2] !== '--prepare') {
  throw Error('Run with --prepare only after the deployer and worker are funded and the local monitor is ready. This starts immutable deadlines.');
}
const root = new URL('../../../', import.meta.url), now = Math.floor(Date.now() / 1000);
const selection = await Bun.file(new URL('config/pilot-alpha-selection.json', root)).json();
const destination = new URL('target/deployments/deterministic-test-prepared.json', root);
await mkdir(new URL('target/deployments/', root), {recursive: true});
let prepared;
if (await Bun.file(destination).exists()) {
  const previous = await Bun.file(destination).json();
  prepared = prepareDeterministicTest(selection, now, previous.publication.draft.closesAt);
  if (prepared.configHash !== previous.configHash) throw Error('Existing deterministic test differs. Inspect and preserve prior artifacts before preparing another collection.');
} else {
  prepared = prepareDeterministicTest(selection, now);
  await writeFile(destination, JSON.stringify(prepared, null, 2) + '\n', {flag: 'wx'});
}
console.log(JSON.stringify({status: prepared.status, mode: prepared.publication.mode, draftHash: prepared.draftHash, configHash: prepared.configHash,
  tradeCloses: new Date(prepared.publication.draft.closesAt * 1000).toISOString(),
  windows: prepared.publication.settlementRules!.map((raw: any) => ({event: raw.eventId, question: raw.question, source: raw.source.urls[0],
    captureOpens: new Date(raw.timing.scheduledAt * 1000).toISOString(), captureCloses: new Date(raw.timing.publicationCutoff * 1000).toISOString(),
    assertionOpens: new Date(raw.timing.observationEndsAt * 1000).toISOString(),
    earliestUnchallengedFinalization: new Date((raw.timing.observationEndsAt + 3600) * 1000).toISOString()})),
  notice: 'Prepared only. The catalogue generation timestamp is not an earthquake publication timestamp. Normal completion takes roughly three hours from preparation; every transition and redemption requires transactions.'}, null, 2));
