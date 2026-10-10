import canonicalize from 'canonicalize';
import { ethers } from 'ethers';
import { createSignDataForClaim, getIdentifierFromClaimInfo } from '@reclaimprotocol/js-sdk';

export const T0 = 1_791_000_000;
export const wallet = new ethers.Wallet('0x' + '22'.repeat(32));
export const TOKEN = 'token-value-that-must-stay-private';
export const EXTRACTED = { matchId: '123', status: 'FINISHED', winner: 'HOME_TEAM' };

export function rule(credential = { kind: 'header', name: 'X-Auth-Token', label: 'football-data' }, attestor = wallet.address.toLowerCase()) {
  return { schema: 'flurbo.settlement-rule.v1', eventId: 'fd-123-home-win', question: 'Will Arsenal beat Chelsea in football-data.org match 123?',
    source: { id: 'football-data-match-123', publisher: 'football-data.org', urls: ['https://api.example.org/v4/matches/123'], adapter: 'proof-http.v1',
      reader: { proof: 'reclaim-http.v1', attestors: [attestor], minSignatures: 1, credential,
        request: { method: 'GET', headers: { accept: 'application/json' } },
        responseRedactions: [{ jsonPath: '$.id' }, { jsonPath: '$.status' }, { jsonPath: '$.score.winner' }],
        responseMatches: [{ type: 'regex', value: '"id":(?<matchId>[0-9]{1,12})' }, { type: 'regex', value: '"status":"(?<status>[A-Z_]{1,20})"' },
          { type: 'regex', value: '"winner":"(?<winner>HOME_TEAM|AWAY_TEAM|DRAW)"' }],
        checks: [{ param: 'matchId', equals: '123' }, { param: 'status', equals: 'FINISHED' }], value: { param: 'winner' } } },
    observation: { series: 'football-data-match-result', period: '2026-10-18T14:00:00Z', unit: 'result' },
    decision: { type: 'category', operator: 'eq', value: 'HOME_TEAM' },
    timing: { scheduledAt: T0, publicationCutoff: T0 + 6 * 3600, correctionCutoff: T0 + 6 * 3600, observationEndsAt: T0 + 6 * 3600,
      assertionPeriod: 3600, challengePeriod: 3600, votingPeriod: 3600 },
    vintage: 'first-observed-snapshot', missingPolicy: 'resolver-timeout-void' };
}

// Stands in for the Reclaim client. The claim is built and signed with the SDK's own functions, not ours.
// `extracted` may be a function of the call number to model a match that finishes between attempts.
export function fakeClient(calls, { timestampS = T0 + 60, extracted = EXTRACTED, fail = null } = {}) {
  return class {
    constructor(appId, appSecret) { this.keys = { appId, appSecret }; }
    async zkFetch(url, publicOptions, secretOptions) {
      calls.push({ ...this.keys, url, publicOptions, secretOptions });
      if (fail) throw Error(fail);
      const values = typeof extracted === 'function' ? extracted(calls.length) : extracted;
      const parameters = canonicalize({ body: '', headers: publicOptions.headers ?? {}, method: publicOptions.method,
        responseMatches: secretOptions.responseMatches, responseRedactions: secretOptions.responseRedactions, url });
      const context = JSON.stringify({ ...publicOptions.context, extractedParameters: values, providerHash: '0x' + '12'.repeat(32) });
      const claimData = { provider: 'http', parameters, owner: wallet.address.toLowerCase(), timestampS, context, epoch: 1 };
      claimData.identifier = getIdentifierFromClaimInfo(claimData);
      return { identifier: claimData.identifier, claimData, signatures: [await wallet.signMessage(createSignDataForClaim(claimData))],
        witnesses: [{ id: wallet.address.toLowerCase(), url: 'wss://attestor.example/ws' }], extractedParameterValues: values };
    }
  };
}
