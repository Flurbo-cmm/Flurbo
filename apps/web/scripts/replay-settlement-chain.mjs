import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { historicalSettlementReplay } from './replay-settlement.mjs';
import { canonical, digest, settlementRuleHash } from '../server/settlement-rules.mjs';
import { replaySettlement } from '../server/settlement-evidence.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = resolve(root, 'target/settlement-replay');
const hash = value => `0x${value}`;
const zero = `0x${'0'.repeat(64)}`;

/** Produce EVM inputs only from the actual archived-source evaluator, not invented outcomes. */
export function historicalChainInput(report) {
  assert.equal(report.liveSubmissionEligible, false);
  function ready(evaluation) {
    assert.equal(evaluation.status, 'ready');
    assert.equal(evaluation.context, 'retrospective-replay');
    assert.equal(evaluation.liveSubmissionEligible, false);
    assert.equal(evaluation.ruleHash, settlementRuleHash(evaluation.packet.rule));
    assert.equal(evaluation.packetHash, digest(canonical(evaluation.packet)));
    // Recompute from the retained raw capture, including parsing, vintage and comparison.
    const repeated = replaySettlement(evaluation.packet.rule, evaluation.packet.captures,
      { asOf: evaluation.evaluatedAt, replayedAt: evaluation.replayedAt });
    assert.equal(repeated.packetHash, evaluation.packetHash);
    return { rule: evaluation.packet.rule, outcome: evaluation.outcome, evidenceHash: hash(evaluation.packetHash),
      sourceHashes: evaluation.packet.captures.map(capture => hash(capture.sha256)) };
  }
  const fed = ready(report.fomc);
  function scenario(policy) {
    const bls = policy.atObservationEnd.status === 'ready' ? ready(policy.atObservationEnd) : null;
    if (!bls) {
      assert.equal(policy.atObservationEnd.status, 'unresolved');
      assert.equal(policy.atObservationEnd.reason, 'RELEASE_UNAVAILABLE');
      assert.equal(policy.ifNoProposalByDeadline.status, 'timeout');
      assert.equal(policy.ifNoProposalByDeadline.timeoutOutcome, 3);
    }
    const definitions = [bls || { rule: policy.rule, outcome: 0, evidenceHash: zero, sourceHashes: [] }, fed];
    const events = definitions.map(event => ({ ruleHash: hash(settlementRuleHash(event.rule)),
      observationEnd: event.rule.timing.observationEndsAt, proposedOutcome: event.outcome,
      finalOutcome: event.outcome || policy.ifNoProposalByDeadline.timeoutOutcome,
      evidenceHash: event.evidenceHash, sourceHashes: event.sourceHashes }));
    const periods = definitions.map(event => ({ assertionPeriod: event.rule.timing.assertionPeriod,
      challengePeriod: event.rule.timing.challengePeriod, votingPeriod: event.rule.timing.votingPeriod }));
    assert.deepEqual(periods[0], periods[1], 'Existing resolver requires shared periods');
    const actions = events.flatMap((event, eventIndex) => [
      ...(event.proposedOutcome ? [{ at: event.observationEnd, kind: 1, eventIndex, outcome: event.proposedOutcome, evidenceHash: event.evidenceHash }] : []),
      { at: event.observationEnd + (event.proposedOutcome ? periods[0].challengePeriod : periods[0].assertionPeriod),
        kind: 2, eventIndex, outcome: event.finalOutcome, evidenceHash: event.evidenceHash },
    ]).sort((a, b) => a.at - b.at || a.kind - b.kind || a.eventIndex - b.eventIndex);
    const units = 1_000_000;
    const expectedPayout = events.some(event => event.finalOutcome === 1) ? 0
      : units / (2 ** events.filter(event => event.finalOutcome === 3).length);
    const draft = { schema: 'flurbo.local-replay-draft.v1', retrospective: true, liveSubmissionEligible: false,
      closesAt: report.parameters.closesAt, ruleHashes: events.map(event => event.ruleHash), ...periods[0] };
    return { name: policy.name, draftHash: hash(digest(canonical(draft))), draft,
      closesAt: draft.closesAt, ...periods[0], events, actions, units, expectedPayout };
  }
  const short = scenario(report.policies[0]), long = scenario(report.policies[2]);
  assert.deepEqual(short.events.map(event => event.finalOutcome), [3, 2]);
  assert.deepEqual(long.events.map(event => event.finalOutcome), [2, 2]);
  return { schema: 'flurbo.local-settlement-chain-input.v1', localOnly: true, retrospective: true, liveSubmissionEligible: false,
    sourceReplayHash: hash(digest(canonical(report))), replayedAt: report.replayedAt, short, long };
}

export async function runHistoricalChainReplay({ forge = process.env.FLURBO_REPLAY_FORGE || 'forge' } = {}) {
  // No arbitrary forge arguments, RPC parameter or production signing capability is accepted.
  const report = await historicalSettlementReplay();
  const input = historicalChainInput(report);
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'historical-report.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(resolve(output, 'evm-input.json'), JSON.stringify(input, null, 2) + '\n');
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(?:FOUNDRY_|DAPP_|ETH_|RPC_|CHAIN_|PRIVATE_KEY|MNEMONIC)/i.test(name)) delete env[name];
  }
  env.FOUNDRY_PROFILE = 'settlement_replay';
  env.FOUNDRY_FFI = 'false';
  const result = spawnSync(forge, ['test', '--root', root, '--offline', '--match-contract', 'HistoricalSettlementChainReplayTest', '-vv', '--json'],
    { cwd: root, env, encoding: 'utf8', maxBuffer: 8_000_000, timeout: 180_000, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`Offline source-to-EVM rehearsal failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  const suites = JSON.parse(result.stdout);
  const results = Object.values(suites).flatMap(suite => Object.entries(suite.test_results || {}));
  assert.equal(results.length, 2, 'Expected both historical policy tests to run');
  for (const [name, test] of results) assert.equal(test.status, 'Success', name);
  const summary = { schema: 'flurbo.local-settlement-chain-report.v1', localOnly: true, retrospective: true,
    liveSubmissionEligible: false, schedulerTested: false, sourceReplayHash: input.sourceReplayHash,
    notice: 'Archived sources fetched in 2026 feed local EVM transactions at historical times. No public chain, live automation, historical trading-performance or source-completeness claim.',
    scenarios: ['short', 'long'].map(name => ({ name, ruleHashes: input[name].events.map(event => event.ruleHash),
      evidenceHashes: input[name].events.map(event => event.evidenceHash), finalOutcomes: input[name].events.map(event => event.finalOutcome),
      expectedPayoutAtoms: input[name].expectedPayout, measurements: results.find(([test]) => test.includes(name === 'short' ? 'Short' : 'Long'))?.[1].decoded_logs || [] })),
    testResults: suites };
  await writeFile(resolve(output, 'chain-report.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw Error('No arguments accepted. This command is local-only and has no RPC or broadcast mode.');
  const result = await runHistoricalChainReplay();
  console.log(JSON.stringify({ output: resolve(output, 'chain-report.json'), scenarios: result.scenarios, schedulerTested: false }, null, 2));
}
