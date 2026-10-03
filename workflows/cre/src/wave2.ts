import { preparePilot, disputePolicy, VOID_POLICY } from './pilot-config';
import { settlementEvent } from '../../../apps/web/server/settlement-publication.mjs';

const iso = (s: number) => new Date(s * 1000).toISOString().replace('.000Z', 'Z');
const hm = (s: number) => iso(s).slice(11, 16);
const timing = (scheduledAt: number, cutoff: number, assertionPeriod: number = 43200) => ({
  scheduledAt, publicationCutoff: cutoff, correctionCutoff: cutoff, observationEndsAt: cutoff,
  assertionPeriod, challengePeriod: 43200, votingPeriod: 43200
});
const base = { schema: 'flurbo.settlement-rule.v1', vintage: 'first-observed-snapshot', missingPolicy: 'resolver-timeout-void' };

// Crypto thresholds are set on listing day from live prices (config/wave2-thresholds.json, read by the prepare
// script). Workflow sources stay free of file access.
export type Wave2Thresholds = { f2?: { mon: number; btc: number; eth: number; sol: number } };

// -------------------------------------------------------------------------------------------------
// F3: Brazil Election (Primary pool for 4 Oct)
// -------------------------------------------------------------------------------------------------
const DAY_OCT4 = Date.UTC(2026, 9, 4) / 1000;
const at = (d: number, h: number, m: number) => Date.UTC(2026, 9, d) / 1000 + h * 3600 + m * 60;

export const F3_LIQUIDITY_ATOMS = '250000000'; // b = 250 test AUSD
export const F3_TIMES = {
  closesAt: at(4, 19, 30),
  captureFrom: at(4, 22, 0),    // 4 Oct 22:00 UTC
  captureUntil: at(7, 6, 0),    // 7 Oct 06:00 UTC
  b4CaptureFrom: at(25, 23, 0), // 25 Oct 23:00 UTC
  b4CaptureUntil: at(27, 12, 0) // 27 Oct 12:00 UTC
};

export function wave2F3Rules() {
  const T = F3_TIMES;
  const tseUrl1 = 'https://resultados.tse.jus.br/oficial/ele2026/6257/dados-simplificados/br/br-c0001-e006257-r.json';
  const tseUrl2 = 'https://resultados.tse.jus.br/oficial/ele2026/6258/dados-simplificados/br/br-c0001-e006258-r.json';
  
  // Custom assertion period for Brazil is 48 hours (172800 seconds). Challenge and voting use default limits (7 days).
  const brazilTiming = timing(T.captureFrom, T.captureUntil, 172800);
  const b4Timing = timing(T.b4CaptureFrom, T.b4CaptureUntil, 172800);
  brazilTiming.challengePeriod = 43200; // 12 hours
  brazilTiming.votingPeriod = 43200; // 12 hours
  b4Timing.challengePeriod = 43200;
  b4Timing.votingPeriod = 43200;

  return [
    { ...base, eventId: 'lula-wins-first-round',
      question: `Will Luiz Inácio Lula da Silva finish first in the first round of the 2026 Brazil presidential election?`,
      source: { id: 'tse-lula-rank1', publisher: 'TSE', urls: [tseUrl1], adapter: 'json-api.v1',
        reader: { select: '/cand', aggregate: 'count', filter: [{ path: '/n', op: 'eq', value: '13' }, { path: '/seq', op: 'eq', value: '1' }], checks: [{ path: '/pst', equals: '100,00' }] } },
      observation: { series: 'tse-election-r1', period: '2026-10-04', unit: 'rank' },
      decision: { type: 'number', operator: 'gte', value: '1' }, timing: brazilTiming },
    { ...base, eventId: 'brazil-runoff',
      question: `Will the 2026 Brazil presidential election require a runoff?`,
      source: { id: 'tse-runoff', publisher: 'TSE', urls: [tseUrl1], adapter: 'json-api.v1',
        reader: { select: '/cand', aggregate: 'count', filter: [{ path: '/st', op: 'eq', value: '2º turno' }], checks: [{ path: '/pst', equals: '100,00' }] } },
      observation: { series: 'tse-election-r1', period: '2026-10-04', unit: 'rank' },
      decision: { type: 'number', operator: 'gte', value: '1' }, timing: brazilTiming },
    { ...base, eventId: 'bolsonaro-runoff',
      question: `Will Flavio Bolsonaro reach the runoff in the 2026 Brazil presidential election?`,
      source: { id: 'tse-bolsonaro-runoff', publisher: 'TSE', urls: [tseUrl1], adapter: 'json-api.v1',
        reader: { select: '/cand', aggregate: 'count', filter: [{ path: '/n', op: 'eq', value: '22' }, { path: '/st', op: 'eq', value: '2º turno' }], checks: [{ path: '/pst', equals: '100,00' }] } },
      observation: { series: 'tse-election-r1', period: '2026-10-04', unit: 'rank' },
      decision: { type: 'number', operator: 'gte', value: '1' }, timing: brazilTiming },
    { ...base, eventId: 'lula-elected-runoff',
      question: `Will Luiz Inácio Lula da Silva be elected in the 25 October runoff in the 2026 Brazil presidential election? If no runoff is held, this question resolves No by operator assertion from the first-round result.`,
      source: { id: 'tse-lula-elected-runoff', publisher: 'TSE', urls: [tseUrl2], adapter: 'json-api.v1',
        reader: { select: '/cand', aggregate: 'only', field: '/st', filter: [{ path: '/n', op: 'eq', value: '13' }], checks: [{ path: '/pst', equals: '100,00' }] } },
      observation: { series: 'tse-election-r2', period: '2026-10-25', unit: 'status' },
      decision: { type: 'category', operator: 'eq', value: 'Eleito' }, timing: b4Timing }
  ];
}

export function prepareWave2F3(selection: { creator: string; reviewers: { name: string; address: string }[] }, now: number) {
  const close = F3_TIMES.closesAt;
  const settlementRules = wave2F3Rules();
  // 48 hours assertion for Brazil (172800), 12 hours challenge/voting (43200)
  const policy = { creator: selection.creator, reviewers: selection.reviewers, reviewerControl: 'single-operator' as const,
    independentReviewersConfirmed: false, rulesReviewed: true, bondAtoms: '1000000', assertionPeriod: 172800, challengePeriod: 43200, votingPeriod: 43200 };
  
  return preparePilot({ schema: 'flurbo.pilot-publication.v1', mode: 'deterministic-source-v1', ...policy, settlementRules,
    draft: { schema: 'flurbo.event-draft.v1', status: 'draft', chainId: 10143, clusterId: `wave2-f3-${close}`,
      title: 'F3 Brazil election', closesAt: close, events: settlementRules.map(settlementEvent),
      exceptionPolicy: VOID_POLICY, disputeModel: 'reviewer-panel', disputePolicy: disputePolicy(policy) } }, now, F3_LIQUIDITY_ATOMS);
}

// -------------------------------------------------------------------------------------------------
// F2: Crypto Weekend
// -------------------------------------------------------------------------------------------------
export const F2_LIQUIDITY_ATOMS = '100000000'; // b = 100 test AUSD
export const F2_TIMES = {
  closesAt: at(3, 18, 0),
  at: at(4, 0, 0),
  captureFrom: at(4, 0, 5),
  captureUntil: at(4, 4, 5),
};

export function wave2F2Rules(thresholds: Wave2Thresholds) {
  const T = F2_TIMES;
  const t = thresholds.f2;
  if (!t || !t.mon || !t.btc || !t.eth || !t.sol) throw Error('Missing f2 thresholds in config/wave2-thresholds.json');
  const cryptoTiming = timing(T.captureFrom, T.captureUntil, 43200); // 12 hours assertion
  cryptoTiming.challengePeriod = 43200; // 12 hours
  cryptoTiming.votingPeriod = 43200;
  
  const tokenRule = (id: string, name: string, token: string, contract: string, val: number, dec: number) => ({
    ...base, eventId: id,
    question: `Will ${name} be at least $${val} on Monad at ${hm(T.at)} UTC on 4 October 2026?`,
    source: { id: `chainlink-${token}-usd`, publisher: 'Chainlink', urls: ['https://rpc.monad.xyz/'], adapter: 'evm-rpc.v1',
      reader: { chainId: 143, at: T.at, metric: 'call', call: { to: contract, data: '0x50d25bcd', returns: 'int256' }, scale: dec, finalitySeconds: 60 } },
    observation: { series: `${token}-usd`, period: '2026-10-04', unit: '$' },
    decision: { type: 'number', operator: 'gte', value: val.toString() }, timing: cryptoTiming
  });

  return [
    tokenRule('crypto-weekend-mon', 'MON', 'mon', '0xBcD78f76005B7515837af6b50c7C52BCf73822fb', t.mon, 8),
    tokenRule('crypto-weekend-btc', 'Bitcoin (BTC)', 'btc', '0xc1d4C3331635184fA4C3c22fb92211B2Ac9E0546', t.btc, 8),
    tokenRule('crypto-weekend-eth', 'Ethereum (ETH)', 'eth', '0x1B1414782B859871781bA3E4B0979b9ca57A0A04', t.eth, 8),
    tokenRule('crypto-weekend-sol', 'Solana (SOL)', 'sol', '0x16F8008c3e89f62e5e2b909Ce70999370D38F4F2', t.sol, 8),
  ];
}

export function prepareWave2F2(selection: { creator: string; reviewers: { name: string; address: string }[] }, now: number, thresholds: Wave2Thresholds) {
  const close = F2_TIMES.closesAt;
  const settlementRules = wave2F2Rules(thresholds);
  const policy = { creator: selection.creator, reviewers: selection.reviewers, reviewerControl: 'single-operator' as const,
    independentReviewersConfirmed: false, rulesReviewed: true, bondAtoms: '1000000', assertionPeriod: 43200, challengePeriod: 43200, votingPeriod: 43200 };
  
  return preparePilot({ schema: 'flurbo.pilot-publication.v1', mode: 'deterministic-source-v1', ...policy, settlementRules,
    draft: { schema: 'flurbo.event-draft.v1', status: 'draft', chainId: 10143, clusterId: `wave2-f2-${close}`,
      title: 'F2 Crypto weekend', closesAt: close, events: settlementRules.map(settlementEvent),
      exceptionPolicy: VOID_POLICY, disputeModel: 'reviewer-panel', disputePolicy: disputePolicy(policy) } }, now, F2_LIQUIDITY_ATOMS);
}
