import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSettlementCapture, replaySettlement } from '../server/settlement-evidence.mjs';
import { settlementTimeline } from '../server/settlement-rules.mjs';

const fixture = name => readFile(new URL(`../tests/fixtures/settlement/${name}.json`, import.meta.url), 'utf8').then(JSON.parse);
const timestamp = value => Date.parse(value) / 1000;
const day = 86400;
const periods = { assertionPeriod: 3600, challengePeriod: 3600, votingPeriod: 3600 };

export async function historicalSettlementReplay() {
  const [bls, fed, previousFed] = await Promise.all([fixture('bls-november-2025'), fixture('fed-december-2025'), fixture('fed-october-2025')]);
  const replayedAt = Math.max(bls.fetchedAt, fed.fetchedAt, previousFed.fetchedAt);
  const scheduledAt = timestamp('2025-12-05T13:30:00Z'); // Historical schedule used only as an explicit replay parameter.
  const closesAt = scheduledAt - 3600;
  const base = { schema: 'flurbo.settlement-rule.v1', eventId: 'historical-unemployment', question: 'Was the initial November 2025 unemployment rate above 4.2 percent?',
    source: { id: 'bls', publisher: 'Bureau of Labor Statistics', urls: [bls.requestedUrl], adapter: 'bls-employment-html.v1' },
    observation: { series: 'LNS14000000', period: '2025-11', unit: 'percent' },
    decision: { type: 'number', operator: 'gt', value: '4.2' }, missingPolicy: 'resolver-timeout-void' };
  const policies = [
    { name: 'One-day publication allowance, strict initial', publication: day, correction: 0, vintage: 'initial' },
    { name: 'Three-day publication allowance, one-day correction allowance', publication: 3 * day, correction: day, vintage: 'initial-with-corrections' },
    { name: 'Twenty-one-day publication allowance, seven-day correction allowance', publication: 21 * day, correction: 7 * day, vintage: 'initial-with-corrections' },
  ].map(policy => {
    const publicationCutoff = scheduledAt + policy.publication, correctionCutoff = publicationCutoff + policy.correction;
    const rule = { ...base, vintage: policy.vintage, timing: { ...periods, scheduledAt, publicationCutoff, correctionCutoff, observationEndsAt: correctionCutoff } };
    return { name: policy.name, ...settlementTimeline(rule, closesAt), rule,
      atObservationEnd: replaySettlement(rule, [bls], { asOf: correctionCutoff, replayedAt }),
      ifNoProposalByDeadline: replaySettlement(rule, [bls], { asOf: correctionCutoff + periods.assertionPeriod, replayedAt }) };
  });
  function fomcRule(capture, period) {
    const scheduledAt = timestamp(`${period}T19:00:00Z`), end = scheduledAt + 3600;
    return { schema: 'flurbo.settlement-rule.v1', eventId: `historical-fomc-${period}`, question: 'Was the announced target upper bound below 4 percent?',
      source: { id: 'fed', publisher: 'Federal Reserve Board', urls: [capture.requestedUrl], adapter: 'fomc-statement-html.v1' },
      observation: { series: 'announced-target-upper-bound', period, unit: 'percent' }, decision: { type: 'number', operator: 'lt', value: '4' },
      vintage: 'initial', missingPolicy: 'resolver-timeout-void', timing: { ...periods, scheduledAt, publicationCutoff: end, correctionCutoff: end, observationEndsAt: end } };
  }
  const fedRule = fomcRule(fed, '2025-12-10'), previousRule = fomcRule(previousFed, '2025-10-29');
  const comparison = { previous: parseSettlementCapture(previousRule, previousFed, replayedAt), current: parseSettlementCapture(fedRule, fed, replayedAt),
    notice: 'Two archived announced upper bounds. A live rate-cut rule must separately precommit the baseline selection and intermeeting-action policy.' };
  return { schema: 'flurbo.historical-settlement-replay.v1', liveSubmissionEligible: false, replayedAt,
    notice: 'Retrospective source parsing and rule evaluation only. Captures were retrieved in 2026, not in 2025. No forecast backtest or unattended automation claim.',
    parameters: { scheduledAt, closesAt, unemploymentThreshold: '4.2', scheduleStatus: 'explicit historical replay parameter' }, policies, comparison,
    fomc: replaySettlement(fedRule, [fed], { asOf: fedRule.timing.observationEndsAt, replayedAt }) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await historicalSettlementReplay();
  const output = resolve('target/settlement-replay');
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'historical-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output: resolve(output, 'historical-report.json'), liveSubmissionEligible: false,
    policies: report.policies.map(policy => ({ name: policy.name, minimumLockHours: policy.minimumLockSeconds / 3600,
      result: policy.atObservationEnd.reason, outcome: policy.atObservationEnd.outcome ?? null })),
    fomcUpperBound: report.comparison.current.value, previousAnnouncedUpperBound: report.comparison.previous.value }, null, 2));
}
