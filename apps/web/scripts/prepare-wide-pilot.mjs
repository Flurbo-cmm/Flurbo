import { readFile, writeFile } from 'node:fs/promises';
import { encodeAbiParameters, keccak256, parseAbiParameters, toHex } from 'viem';

const address = value => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
  && !/^0x0{40}$/i.test(value);
const hash = value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
  && !/^0x0{64}$/i.test(value);
const integer = value => Number.isSafeInteger(value) && value > 0;
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 500;
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const configAbi = parseAbiParameters('(address collateral, bytes32 draftHash, uint64 closesAt, bytes32[] eventHashes, uint64[] observationEnds, address relay, uint32 reportPeriod) config');
const eventAbi = parseAbiParameters('string domain, bytes32 draftHash, uint8 bit, string eventId');
const testAusd = '0xa9012a055bd4e0edff8ce09f960291c09d5322dc';

function checkSource(source) {
  if (source?.kind === 'reality-sepolia') {
    if (source.chainId !== 11155111 || !address(source.reality) || !address(source.arbitrator)
      || !hash(source.questionId) || !hash(source.contentHash) || !integer(source.minTimeout)
      || source.minTimeout < 3600 || !/^[1-9][0-9]*$/.test(source.minBond)) throw Error('Invalid Reality source');
  } else if (source?.kind === 'private-proof') {
    if (!['keyed-api', 'login-page'].includes(source.access) || !text(source.providerId)
      || !text(source.providerVersion) || !text(source.recordId) || !text(source.field))
      throw Error('Invalid private proof source');
  } else if (source?.kind === 'deterministic') {
    if (!hash(source.ruleHash)) throw Error('Invalid deterministic source');
  } else throw Error('Unsupported source');
}

export function wideCommitments(input) {
  const draft = { schema: input.schema, chainId: input.chainId, title: input.title,
    closesAt: input.closesAt, events: input.events, trustModel: input.trustModel,
    relay: input.relay, reportPeriod: input.reportPeriod };
  const draftHash = keccak256(toHex(canonical(draft)));
  const eventHashes = input.events.map((event, bit) => keccak256(encodeAbiParameters(eventAbi,
    ['flurbo.wide.event.v3', draftHash, bit, event.id])));
  return { draftHash, eventHashes };
}

export function prepareWidePilot(input, now = Math.floor(Date.now() / 1000)) {
  if (input?.schema !== 'flurbo.wide-publication.v3' || input.chainId !== 10143
    || input.trustModel !== 'trusted-source-relay' || input.rulesReviewed !== true
    || !address(input.creator) || !text(input.title) || !integer(input.closesAt)
    || input.closesAt <= now + 3600 || input.closesAt > now + 30 * 86400
    || !Array.isArray(input.events) || input.events.length < 2 || input.events.length > 32
    || !address(input.relay) || input.relay.toLowerCase() === input.creator.toLowerCase()
    || !integer(input.reportPeriod) || input.reportPeriod < 3600 || input.reportPeriod > 90 * 86400
    || ['reviewers', 'bondAtoms', 'assertionPeriod', 'challengePeriod', 'votingPeriod'].some(key => key in input)
    || !/^[1-9][0-9]*$/.test(input.liquidityAtoms) || BigInt(input.liquidityAtoms) < 10_000_000n
    || BigInt(input.liquidityAtoms) > 1_000_000_000_000n) throw Error('Invalid wide publication');
  const ids = new Set(), realityIds = new Set();
  for (const event of input.events) {
    if (!text(event?.id) || !/^[a-z0-9][a-z0-9:_-]{0,95}$/.test(event.id)
      || !text(event.question) || !integer(event.observationEndsAt)
      || event.observationEndsAt <= input.closesAt || event.observationEndsAt > now + 90 * 86400
      || ids.has(event.id)) throw Error('Invalid or duplicate event');
    checkSource(event.source);
    if (event.source.kind === 'reality-sepolia') {
      const key = event.source.reality.toLowerCase() + ':' + event.source.questionId.toLowerCase();
      if (realityIds.has(key)) throw Error('Duplicate Reality question');
      realityIds.add(key);
    }
    ids.add(event.id);
  }
  const { draftHash, eventHashes } = wideCommitments(input);
  const config = {
    collateral: testAusd, draftHash, closesAt: BigInt(input.closesAt), eventHashes,
    observationEnds: input.events.map(event => BigInt(event.observationEndsAt)),
    relay: input.relay, reportPeriod: input.reportPeriod,
  };
  const resolverConfig = encodeAbiParameters(configAbi, [config]);
  return { schema: 'flurbo.wide-prepared.v3', status: 'prepared_not_deployed',
    creator: input.creator, publication: input, draftHash, eventHashes,
    resolverConfig, configHash: keccak256(resolverConfig), liquidityAtoms: input.liquidityAtoms };
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replaceAll('\\', '/')}`).href) {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination) throw Error('Usage: node prepare-wide-pilot.mjs <input.json> <output.json>');
  const input = JSON.parse(await readFile(source, 'utf8'));
  const prepared = prepareWidePilot(input);
  await writeFile(destination, JSON.stringify(prepared, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify({ status: prepared.status, count: prepared.eventHashes.length,
    draftHash: prepared.draftHash, configHash: prepared.configHash, output: destination }) + '\n');
}
