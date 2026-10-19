import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRule } from '../scripts/check-settlement-rule.mjs';

const mlbRule = {
  schema: 'flurbo.settlement-rule.v1', eventId: 'flb-1-11',
  question: 'Will the Cleveland Guardians (home) win ALCS Game 4 (gamePk 849817) against the Tampa Bay Rays on 2026-10-16 in the MLB Stats API?',
  source: { id: 'mlb-statsapi-849817', publisher: 'Major League Baseball Stats API',
    urls: ['https://statsapi.mlb.com/api/v1/schedule?sportId=1&gamePk=849817'], adapter: 'json-api.v2',
    reader: { select: '/dates/0/games/0/teams/home/isWinner', aggregate: 'value',
      checks: [{ path: '/dates/0/games/0/gamePk', equals: '849817' }] } },
  observation: { series: 'mlb-home-win-849817', period: '2026-10-16', unit: 'boolean' },
  decision: { type: 'category', operator: 'eq', value: 'true' },
  timing: { scheduledAt: 1792209600, publicationCutoff: 1792231200, correctionCutoff: 1792231200,
    observationEndsAt: 1792231200, assertionPeriod: 3600, challengePeriod: 3600, votingPeriod: 86400 },
  vintage: 'first-observed-snapshot', missingPolicy: 'resolver-timeout-void' };

const usgsRule = {
  schema: 'flurbo.settlement-rule.v1', eventId: 'flb-1-13',
  question: 'Will the USGS ComCat API record at least 3 earthquakes with magnitude 4.5 or higher worldwide between 2026-10-16T14:00:00Z and 2026-10-17T02:00:00Z?',
  source: { id: 'usgs-fdsnws', publisher: 'United States Geological Survey',
    urls: ['https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=2026-10-16T14:00:00Z&endtime=2026-10-17T02:00:00Z&minmagnitude=4.5&eventtype=earthquake&orderby=time-asc'],
    adapter: 'json-api.v1', reader: { select: '/features', aggregate: 'count' } },
  observation: { series: 'usgs-mag-4.5-count', period: '2026-10-16T14:00:00Z/2026-10-17T02:00:00Z', unit: 'events' },
  decision: { type: 'number', operator: 'gte', value: '3' },
  timing: { scheduledAt: 1792213200, publicationCutoff: 1792234800, correctionCutoff: 1792234800,
    observationEndsAt: 1792234800, assertionPeriod: 3600, challengePeriod: 3600, votingPeriod: 86400 },
  vintage: 'first-observed-snapshot', missingPolicy: 'resolver-timeout-void' };

function stub(value: unknown) {
  const urls: string[] = [];
  const request = async (url: string) => {
    urls.push(url);
    const body = Buffer.from(JSON.stringify(value));
    return { status: 200, redirected: false, url, body: (async function* () { yield body; })(),
      headers: { has: () => false, get: (name: string) => name === 'content-type' ? 'application/json' : null } };
  };
  return { urls, request };
}
const cutoff = mlbRule.timing.publicationCutoff;
const game = (detailedState: string, hoursBeforeCutoff: number) => ({ dates: [{ games: [{ gamePk: 849817,
  gameDate: new Date((cutoff - hoursBeforeCutoff * 3600) * 1000).toISOString(),
  status: { detailedState }, teams: { home: {}, away: {} } }] }] });
const check = (rule: any, body: unknown) => {
  const { urls, request } = stub(body);
  return checkRule(rule, { now: rule.timing.scheduledAt - 86400, request }).then((report: any) => ({ report, urls }));
};

test('an MLB gamePk missing from the schedule fails the rule check', async () => {
  const { report } = await check(mlbRule, { dates: [] });
  assert.equal(report.status, 'invalid');
  assert.match(report.message, /gamePk 849817 is not in the MLB schedule/);
  assert.equal(report.sources[0].subject.result, 'subject-missing');
});

test('a postponed MLB game fails the rule check', async () => {
  const { report } = await check(mlbRule, game('Postponed', 8));
  assert.equal(report.status, 'invalid');
  assert.match(report.message, /Postponed/);
  assert.equal(report.sources[0].subject.result, 'subject-postponed');
});

test('a game that starts too close to the capture cutoff fails the rule check', async () => {
  const { report } = await check(mlbRule, game('Scheduled', 2));
  assert.equal(report.status, 'invalid');
  assert.equal(report.sources[0].subject.result, 'subject-late');
});

test('a scheduled MLB game well before the cutoff passes the subject check', async () => {
  const { report } = await check(mlbRule, game('Scheduled', 8));
  assert.equal(report.sources[0].subject.result, 'subject-ok');
  assert.equal(report.sources[0].result, 'not-yet-available');
  assert.equal(report.status, 'ok');
  assert.deepEqual(report.warnings, ['Add a check {"path":"/dates/0/games/0/status/detailedState","equals":"Final"} so a game that is not final reads as missing, not as a result.']);
});

test('rules for other sources are not subject-checked', async () => {
  const { report, urls } = await check(usgsRule, { features: [] });
  assert.equal(report.sources[0].subject, undefined);
  assert.equal(urls.length, 1);
});
