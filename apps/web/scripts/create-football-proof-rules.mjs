import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateSettlementRule } from '../server/settlement-rules.mjs';

// Two football-data.org rules for one match, both read through a TLS proof of the match resource: the home win
// and "at least three goals". The free plan delays scores, so the capture window opens three hours after kickoff.
const name = value => typeof value === 'string' && value.length > 0 && value.length <= 40 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);

export function footballProofRules({ matchId, kickoff, home, away, attestors, minSignatures = 1, timeout = 3600 }) {
  if (!/^[1-9][0-9]{0,11}$/.test(matchId ?? '') || !Number.isSafeInteger(kickoff) || kickoff <= 0 || !name(home) || !name(away)) throw Error('Invalid football match');
  const iso = new Date(kickoff * 1000).toISOString().replace('.000Z', 'Z');
  const url = `https://api.football-data.org/v4/matches/${matchId}`;
  const end = kickoff + 30 * 3600;
  const timing = { scheduledAt: kickoff + 3 * 3600, publicationCutoff: end, correctionCutoff: end, observationEndsAt: end,
    assertionPeriod: 3600, challengePeriod: timeout, votingPeriod: 3600 };
  const rule = ({ suffix, question, series, unit, decision, jsonPaths, matches, value }) => ({ schema: 'flurbo.settlement-rule.v1',
    eventId: `fd-${matchId}-${suffix}`, question,
    source: { id: `football-data-match-${matchId}`, publisher: 'football-data.org', urls: [url], adapter: 'proof-http.v1',
      reader: { proof: 'reclaim-http.v1', attestors: [...attestors], minSignatures,
        credential: { kind: 'header', name: 'X-Auth-Token', label: 'football-data' },
        request: { method: 'GET', headers: { accept: 'application/json' } },
        responseRedactions: jsonPaths.map(jsonPath => ({ jsonPath })),
        responseMatches: matches.map(value => ({ type: 'regex', value })),
        checks: [{ param: 'matchId', equals: matchId }, { param: 'status', equals: 'FINISHED' }], value } },
    observation: { series, period: iso, unit }, decision, timing: { ...timing },
    vintage: 'first-observed-snapshot', missingPolicy: 'resolver-timeout-void' });
  const identity = ['"id":(?<matchId>[0-9]{1,12})', '"status":"(?<status>[A-Z_]{1,20})"'];
  const rules = [
    rule({ suffix: 'home-win', question: `Will ${home} beat ${away} in football-data.org match ${matchId} (kickoff ${iso})?`,
      series: 'football-data-match-result', unit: 'result', decision: { type: 'category', operator: 'eq', value: 'HOME_TEAM' },
      jsonPaths: ['$.id', '$.status', '$.score.winner'], matches: [...identity, '"winner":"(?<winner>HOME_TEAM|AWAY_TEAM|DRAW)"'], value: { param: 'winner' } }),
    rule({ suffix: 'goals', question: `Will football-data.org match ${matchId} (${home} v ${away}, kickoff ${iso}) end with at least 3 goals in total?`,
      series: 'football-data-total-goals', unit: 'goals', decision: { type: 'number', operator: 'gte', value: '3' },
      jsonPaths: ['$.id', '$.status', '$.score.fullTime.home', '$.score.fullTime.away'],
      matches: [...identity, '"home":(?<homeGoals>[0-9]{1,3})', '"away":(?<awayGoals>[0-9]{1,3})'], value: { sum: ['homeGoals', 'awayGoals'] } }),
  ];
  return rules.map(validateSettlementRule);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [matchId, kickoff, home, away, attestors, output] = process.argv.slice(2);
  if (!output || !/^[1-9]\d*$/.test(kickoff || '') || !attestors)
    throw Error('Usage: node create-football-proof-rules.mjs MATCH_ID KICKOFF_UNIX HOME AWAY ATTESTOR[,ATTESTOR] OUTPUT.json');
  const rules = footballProofRules({ matchId, kickoff: Number(kickoff), home, away, attestors: attestors.split(',') });
  await writeFile(output, JSON.stringify(rules, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: 'rules_created', rules: rules.map(rule => rule.eventId), output }));
}
