import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeAbiParameters, encodeAbiParameters, keccak256, parseAbiParameters, toHex } from 'viem';
import { canonical, settlementRuleHash, validateSettlementRule } from '../server/settlement-rules.mjs';
import { hybridArbitrator, SEPOLIA_REALITY, TEST_AUSD } from '../server/oracle-integration.mjs';

export const hybridConfigAbi = parseAbiParameters('(address collateral,bytes32 draftHash,uint64 closesAt,bytes32[] eventHashes,uint64[] observationEnds,uint8[] routes,address proposer,address relay,uint128 bond,uint32 assertionPeriod,uint32 challengePeriod,uint32 reportPeriod,uint32 arbitrationPeriod) config');
const address = value => /^0x[0-9a-fA-F]{40}$/.test(value || '') && !/^0x0{40}$/i.test(value);
const hash = value => /^0x[0-9a-fA-F]{64}$/.test(value || '') && !/^0x0{64}$/i.test(value);
const duration = (value, low, high) => Number.isSafeInteger(value) && value >= low && value <= high;
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
export const ruleUriPattern = /^https:\/\/[a-z0-9.-]+\/api\/hybrid\/rules\/0x[0-9a-f]{64}$/;
const LS_PUBLICATION = 'flurbo.hybrid-publication.v5';
export const LS_PREPARED = 'flurbo.hybrid-prepared.v5';
export const isLsPrepared = prepared => prepared?.schema === LS_PREPARED;
export function realityQuestionText(question, ruleURI) {
  return `${question} Resolution rule: ${ruleURI}. Answer Invalid if the rule result is VOID.␟flurbo␟en`;
}

export function hybridRulesHash(prepared, resolver) {
  if (!['flurbo.hybrid-prepared.v4', LS_PREPARED].includes(prepared?.schema) || !address(resolver))
    throw Error('Invalid hybrid rules hash input');
  const [config] = decodeAbiParameters(hybridConfigAbi, prepared.resolverConfig);
  if (keccak256(prepared.resolverConfig) !== prepared.configHash
    || config.draftHash !== prepared.draftHash || !same(config.proposer, prepared.proposer)
    || !same(config.relay, prepared.relay)) throw Error('Hybrid configuration changed');
  return keccak256(encodeAbiParameters([
    ...parseAbiParameters('string domain,uint256 chainId,address resolver,address creator'), ...hybridConfigAbi,
  ], ['flurbo.pilot.hybrid.v4', 10143n, resolver, prepared.creator, config]));
}

export function prepareHybridPilot(input) {
  const ls = input?.schema === LS_PUBLICATION;
  if (!['flurbo.hybrid-publication.v4', LS_PUBLICATION].includes(input?.schema) || input.chainId !== 10143
    || (ls ? !Number.isSafeInteger(input.commissionBps) || input.commissionBps < 100 || input.commissionBps > 2000
      : 'commissionBps' in input)
    || input.rulesReviewed !== true || ![input.creator, input.proposer, input.relay].every(address)
    || same(input.creator, input.proposer) || same(input.creator, input.relay)
    || same(input.proposer, input.relay) || typeof input.title !== 'string'
    || input.title.length < 8 || input.title.length > 120
    || !Number.isSafeInteger(input.closesAt) || input.closesAt <= 0
    || !duration(input.assertionPeriod, 3600, 30 * 86400)
    || !duration(input.challengePeriod, 3600, 7 * 86400)
    || !duration(input.reportPeriod, 3600, 90 * 86400)
    || !duration(input.arbitrationPeriod, 30 * 86400, 365 * 86400)
    || !/^(?:0|[1-9]\d*)$/.test(input.bondAtoms || '') || BigInt(input.bondAtoms) < 1n
    || BigInt(input.bondAtoms) > (1n << 128n) - 1n
    || !/^(?:0|[1-9]\d*)$/.test(input.liquidityAtoms || '')
    || BigInt(input.liquidityAtoms) < 10_000_000n || BigInt(input.liquidityAtoms) > 1_000_000_000_000n
    || !Array.isArray(input.events) || input.events.length < 2 || input.events.length > 32)
    throw Error('Invalid hybrid publication');
  const ids = new Set();
  for (const event of input.events) {
    if (typeof event?.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(event.id)
      || ids.has(event.id) || typeof event.question !== 'string' || event.question.length < 12
      || event.question.length > 1000 || !Number.isSafeInteger(event.observationEndsAt)
      || event.observationEndsAt <= input.closesAt || !['mechanical', 'reality'].includes(event.route))
      throw Error('Invalid hybrid event');
    ids.add(event.id);
    if (event.route === 'mechanical') {
      if (event.source !== undefined || !event.rule) throw Error('Mechanical event needs one rule');
      const rule = validateSettlementRule(event.rule);
      if (rule.eventId !== event.id || rule.question !== event.question
        || rule.timing.observationEndsAt !== event.observationEndsAt
        || rule.timing.assertionPeriod !== input.assertionPeriod
        || rule.timing.challengePeriod !== input.challengePeriod)
        throw Error('Mechanical rule differs from its event');
    } else {
      if (event.source?.kind !== 'reality-sepolia'
        || event.source.chainId !== 11155111 || !same(event.source.reality || '', SEPOLIA_REALITY)
        || !hybridArbitrator(event.source.arbitrator)
        || !hash(event.source.questionId) || !hash(event.source.contentHash)
        || !hash(event.source.questionTxHash)
        || !duration(event.source.minTimeout, 3600, 30 * 86400)
        || !/^[1-9]\d*$/.test(event.source.minBond || '')
        || event.source.openingAt !== event.observationEndsAt)
        throw Error('Invalid Reality source');
      if (event.rule !== undefined) {
        const rule = validateSettlementRule(event.rule);
        if (rule.eventId !== event.id || rule.question !== event.question
          || rule.timing.observationEndsAt !== event.observationEndsAt
          || rule.timing.publicationCutoff > event.observationEndsAt
          || rule.timing.challengePeriod !== event.source.minTimeout
          || rule.timing.assertionPeriod !== input.assertionPeriod)
          throw Error('Reality rule differs from its event');
        if (!ruleUriPattern.test(event.source.ruleURI || '')
          || !event.source.ruleURI.endsWith(`/0x${settlementRuleHash(rule)}`)
          || event.source.questionText !== realityQuestionText(event.question, event.source.ruleURI))
          throw Error('Invalid Reality source');
      }
    }
  }
  const draft = { schema: input.schema, chainId: input.chainId, creator: input.creator,
    title: input.title, closesAt: input.closesAt, assertionPeriod: input.assertionPeriod,
    challengePeriod: input.challengePeriod, reportPeriod: input.reportPeriod,
    arbitrationPeriod: input.arbitrationPeriod, bondAtoms: input.bondAtoms,
    liquidityAtoms: input.liquidityAtoms, ...(ls ? { commissionBps: input.commissionBps } : {}), events: input.events };
  const draftHash = keccak256(toHex(canonical(draft)));
  const eventHashes = input.events.map((event, index) => keccak256(encodeAbiParameters(
    parseAbiParameters('string domain,bytes32 draftHash,uint8 eventIndex,string eventId,string route,bytes32 sourceHash'),
    ['flurbo.hybrid.event.v4', draftHash, index, event.id, event.route,
      event.route === 'mechanical' ? `0x${settlementRuleHash(event.rule)}`
        : keccak256(toHex(canonical(event.rule === undefined ? event.source
          : { source: event.source, rule: event.rule })))])));
  const config = { collateral: TEST_AUSD, draftHash, closesAt: BigInt(input.closesAt),
    eventHashes, observationEnds: input.events.map(event => BigInt(event.observationEndsAt)),
    routes: input.events.map(event => event.route === 'mechanical' ? 0 : 1),
    proposer: input.proposer, relay: input.relay, bond: BigInt(input.bondAtoms),
    assertionPeriod: input.assertionPeriod, challengePeriod: input.challengePeriod,
    reportPeriod: input.reportPeriod, arbitrationPeriod: input.arbitrationPeriod };
  const resolverConfig = encodeAbiParameters(hybridConfigAbi, [config]);
  return { schema: ls ? LS_PREPARED : 'flurbo.hybrid-prepared.v4', chainId: 10143, creator: input.creator,
    proposer: input.proposer, relay: input.relay,
    draft, draftHash, eventHashes, configHash: keccak256(resolverConfig), resolverConfig,
    liquidityAtoms: input.liquidityAtoms, ...(ls ? { commissionBps: input.commissionBps } : {}) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw Error('Usage: node prepare-hybrid-pilot.mjs INPUT.json OUTPUT.json');
  const prepared = prepareHybridPilot(JSON.parse(await readFile(input, 'utf8')));
  await writeFile(output, JSON.stringify(prepared, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: 'prepared', eventCount: prepared.draft.events.length,
    draftHash: prepared.draftHash, configHash: prepared.configHash, output }));
}
