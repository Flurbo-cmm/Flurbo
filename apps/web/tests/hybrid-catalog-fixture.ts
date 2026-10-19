import { prepareHybridPilot, hybridRulesHash, realityQuestionText } from '../scripts/prepare-hybrid-pilot.mjs';
import { settlementRuleHash } from '../server/settlement-rules.mjs';
import { SEPOLIA_KLEROS, SEPOLIA_REALITY } from '../server/oracle-integration.mjs';

export const at = 1_800_000_000;
export const account = (digit: string) => `0x${digit.repeat(40)}`;
export const resolver = account('4'), pool = account('5');
export const ruleFor = (id: string, observationEndsAt: number, question: string) => ({ schema: 'flurbo.settlement-rule.v1', eventId: id, question,
  source: { id: 'official-source', publisher: 'Official publisher',
    urls: ['https://data.example.org/value'], adapter: 'json-api.v1',
    reader: { select: '/value', aggregate: 'value' } },
  observation: { series: 'official-value', period: '2027-01', unit: 'units' },
  decision: { type: 'number', operator: 'gte', value: '4' },
  timing: { scheduledAt: observationEndsAt - 3600, publicationCutoff: observationEndsAt,
    correctionCutoff: observationEndsAt, observationEndsAt,
    assertionPeriod: 3600, challengePeriod: 3600, votingPeriod: 3600 },
  vintage: 'first-observed-snapshot', missingPolicy: 'resolver-timeout-void' });
export function catalog(routes: string[] = ['mechanical', 'mechanical'], actors: Record<string, string> = {},
  { commissionBps = null }: { commissionBps?: number | null } = {}) {
  const who = { proposer: account('2'), relay: account('3'), keeper: account('8'), answerer: account('9'), ...actors };
  const question = 'Will the official value be at least four?';
  const rule = (id: string) => ruleFor(id, at + 3600, question);
  const pricing = commissionBps === null ? { schema: 'flurbo.hybrid-publication.v4' }
    : { schema: 'flurbo.hybrid-publication.v5', commissionBps };
  const prepared = prepareHybridPilot({ ...pricing, chainId: 10143,
    rulesReviewed: true, creator: account('1'), proposer: who.proposer, relay: who.relay,
    title: 'Objective source test pool', closesAt: at - 3600, assertionPeriod: 3600,
    challengePeriod: 3600, reportPeriod: 86400, arbitrationPeriod: 30 * 86400,
    bondAtoms: '1000000', liquidityAtoms: '10000000',
    events: routes.map((route, index) => {
      const id = ['first', 'second', 'third'][index];
      const base = { id, question, observationEndsAt: at + 3600, rule: rule(id) };
      if (route === 'mechanical') return { ...base, route: 'mechanical' };
      const ruleURI = `https://flurbopm.singu.online/api/hybrid/rules/0x${settlementRuleHash(base.rule)}`;
      return { ...base, route: 'reality', source: { kind: 'reality-sepolia', chainId: 11155111,
        reality: SEPOLIA_REALITY, arbitrator: SEPOLIA_KLEROS, ruleURI,
        questionId: `0x${['a', 'b', '1'][index].repeat(64)}`, contentHash: `0x${['c', 'd', '2'][index].repeat(64)}`,
        questionTxHash: `0x${['e', 'f', '3'][index].repeat(64)}`,
        questionText: realityQuestionText(question, ruleURI), minTimeout: 3600,
        minBond: '100000000000000', openingAt: at + 3600 } };
    }) });
  const mechanical = routes.includes('mechanical');
  return { schema: 'flurbo.hybrid-catalog.v1', pools: [{ id: 'objective-test', pool, resolver,
    rulesHash: hybridRulesHash(prepared, resolver), deploymentBlock: 100,
    ...(mechanical ? { adapter: account('6'), manager: account('7') } : {}),
    ...(routes.includes('reality') ? { keeper: who.keeper, answerer: who.answerer } : {}), prepared }] };
}
export const realityCatalog = () => catalog(['reality', 'reality']);

// One catalog pool record with `count` mechanical questions, for pool-level tests.
export function hybridRecord({ count = 2, pool: poolAddress = pool, resolver: resolverAddress = resolver, closesAt = at - 3600,
  commissionBps = null }:
  { count?: number; pool?: string; resolver?: string; closesAt?: number; commissionBps?: number | null } = {}) {
  const observationEndsAt = closesAt + 3600;
  const pricing = commissionBps === null ? { schema: 'flurbo.hybrid-publication.v4' }
    : { schema: 'flurbo.hybrid-publication.v5', commissionBps };
  const prepared = prepareHybridPilot({ ...pricing, chainId: 10143,
    rulesReviewed: true, creator: account('1'), proposer: account('2'), relay: account('3'),
    title: 'Explicit test fixtures', closesAt, assertionPeriod: 3600,
    challengePeriod: 3600, reportPeriod: 86400, arbitrationPeriod: 30 * 86400,
    bondAtoms: '1000000', liquidityAtoms: '10000000',
    events: Array.from({ length: count }, (_, i) => {
      const id = `event-${i}`, question = `Test event ${i + 1}: will the official value be at least four?`;
      return { id, question, observationEndsAt, route: 'mechanical', rule: ruleFor(id, observationEndsAt, question) };
    }) });
  return { id: `pool-${count}-${poolAddress.slice(2, 10).toLowerCase()}`, pool: poolAddress, resolver: resolverAddress,
    rulesHash: hybridRulesHash(prepared, resolverAddress), deploymentBlock: 100,
    adapter: account('6'), manager: account('7'), prepared };
}
