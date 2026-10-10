import { privateKeyToAccount } from 'viem/accounts';
import { digest, settlementRuleHash } from '../server/settlement-rules.mjs';
import { jcs, PROOF_CONTEXT_ADDRESS, proofContextMessage, reclaimIdentifier, reclaimSignData } from '../server/source-proof.mjs';

export const T0 = 1_791_000_000;
export const ATTESTOR_KEY = `0x${'22'.repeat(32)}` as const;
export const ATTESTOR = '0x1563915e194d8cfba1943570603f7606a3115508';
export const OTHER_KEY = `0x${'33'.repeat(32)}` as const;
export const MATCH_URL = 'https://api.example.org/v4/matches/123';

const READER = {
  proof: 'reclaim-http.v1', attestors: [ATTESTOR], minSignatures: 1,
  credential: { kind: 'header', name: 'X-Auth-Token', label: 'football-data' },
  request: { method: 'GET', headers: { accept: 'application/json' } },
  responseRedactions: [{ jsonPath: '$.id' }, { jsonPath: '$.status' }, { jsonPath: '$.score.winner' },
    { jsonPath: '$.score.fullTime.home' }, { jsonPath: '$.score.fullTime.away' }],
  responseMatches: [
    { type: 'regex', value: '"id":(?<matchId>[0-9]{1,12})' },
    { type: 'regex', value: '"status":"(?<status>[A-Z_]{1,20})"' },
    { type: 'regex', value: '"winner":"(?<winner>HOME_TEAM|AWAY_TEAM|DRAW)"' },
    { type: 'regex', value: '"home":(?<homeGoals>[0-9]{1,3})' },
    { type: 'regex', value: '"away":(?<awayGoals>[0-9]{1,3})' },
  ],
  checks: [{ param: 'matchId', equals: '123' }, { param: 'status', equals: 'FINISHED' }],
  value: { param: 'winner' },
};

export function proofRule(over: { reader?: object; decision?: object; url?: string; timing?: object } = {}): any {
  return { schema: 'flurbo.settlement-rule.v1', eventId: 'fd-123-home-win',
    question: 'Will Arsenal beat Chelsea in football-data.org match 123 (kickoff 2026-10-18T14:00:00Z)?',
    source: { id: 'football-data-match-123', publisher: 'football-data.org', urls: [over.url ?? MATCH_URL], adapter: 'proof-http.v1',
      reader: structuredClone({ ...READER, ...over.reader }) },
    observation: { series: 'football-data-match-result', period: '2026-10-18T14:00:00Z', unit: 'result' },
    decision: over.decision ?? { type: 'category', operator: 'eq', value: 'HOME_TEAM' },
    timing: { scheduledAt: T0, publicationCutoff: T0 + 6 * 3600, correctionCutoff: T0 + 6 * 3600, observationEndsAt: T0 + 6 * 3600,
      assertionPeriod: 3600, challengePeriod: 3600, votingPeriod: 3600, ...over.timing },
    vintage: 'first-observed-snapshot', missingPolicy: 'resolver-timeout-void' };
}

export async function proofCapture(rule: any, options: { extracted?: Record<string, string>; timestampS?: number; keys?: `0x${string}`[];
  parameters?: string; context?: object; fetchedAt?: number; ruleHash?: string } = {}): Promise<any> {
  const r = rule.source.reader, url = rule.source.urls[0], timestampS = options.timestampS ?? T0 + 60;
  const parameters = options.parameters ?? jcs({ body: '', headers: r.request.headers ?? {}, method: r.request.method,
    responseMatches: r.responseMatches, responseRedactions: r.responseRedactions, url });
  const context = JSON.stringify({ contextAddress: PROOF_CONTEXT_ADDRESS,
    contextMessage: proofContextMessage(options.ruleHash ?? settlementRuleHash(rule)),
    extractedParameters: options.extracted ?? { matchId: '123', status: 'FINISHED', winner: 'HOME_TEAM', homeGoals: '2', awayGoals: '1' },
    providerHash: '0x' + '12'.repeat(32), ...options.context });
  const claimData: any = { provider: 'http', parameters, owner: '0x' + 'cd'.repeat(20), timestampS, context, epoch: 1 };
  claimData.identifier = reclaimIdentifier(claimData);
  const message = reclaimSignData(claimData);
  const signatures = await Promise.all((options.keys ?? [ATTESTOR_KEY]).map(key => privateKeyToAccount(key).signMessage({ message })));
  const body = JSON.stringify({ schema: 'flurbo.proof-capture.v1', proof: { identifier: claimData.identifier, claimData, signatures } });
  return { requestedUrl: url, finalUrl: url, fetchedAt: options.fetchedAt ?? timestampS, status: 200, contentType: 'application/json',
    complete: true, body, bytes: Buffer.byteLength(body), sha256: digest(body) };
}

export function withBody(capture: any, edit: (body: any) => void) {
  const body = JSON.parse(capture.body); edit(body);
  const text = JSON.stringify(body);
  return { ...capture, body: text, bytes: Buffer.byteLength(text), sha256: digest(text) };
}
