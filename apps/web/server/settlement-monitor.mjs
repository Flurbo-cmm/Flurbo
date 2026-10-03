import { decodeFunctionResult, encodeFunctionData } from 'viem';
import { pilotService } from './pilot.mjs';
import { pilotCash, pilotPoolAbi, resolverAbi } from '../shared/pilot.mjs';

const outcomes = ['Unset', 'NO', 'YES', 'VOID'];
const phases = ['Pending', 'Asserted', 'Disputed', 'Finalized'];
const hash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);
const integer = value => {
  if (!/^(0|[1-9][0-9]*)$/.test(String(value))) throw new Error('Invalid monitoring value');
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error('Invalid monitoring value');
  return n;
};
const atoms = value => {
  if (!/^(0|[1-9][0-9]*)$/.test(String(value))) throw new Error('Invalid collateral value');
  return BigInt(value);
};
export const monitorIdentity = manifest => `${manifest.chainId}:${manifest.pool}:${manifest.resolver}:${manifest.rulesHash}`;

// A checkpoint records the last complete read, never an email acknowledgement.
export function validateMonitorCheckpoint(previous, manifest) {
  if (previous === null) return;
  if (previous?.schema !== 'flurbo.settlement-checkpoint.v1' || previous.identity !== monitorIdentity(manifest)
    || !hash(previous.snapshot?.blockHash) || typeof previous.delivered !== 'boolean' || !Array.isArray(previous.cases)
    || previous.cases.length !== manifest.publication.draft.events.length) throw new Error('Invalid monitor checkpoint');
  integer(previous.snapshot.blockNumber); integer(previous.snapshot.timestamp); integer(previous.checkedAt);
  for (const c of previous.cases) {
    if (!phases[c.phase] || !outcomes[c.result] || !Array.isArray(c.votes) || c.votes.length !== 3) throw new Error('Invalid monitor checkpoint');
    c.votes.forEach(integer);
  }
}

// Keep phase decisions pure and tied to chain time. Wall time only diagnoses stale reads.
export function settlementReport(state, { now, previous = null, checkpointReorg = false }) {
  const { manifest, snapshot, cases, timing } = state;
  validateMonitorCheckpoint(previous, manifest);
  const checkedAt = integer(now), chainTime = integer(snapshot.timestamp);
  if (previous && previous.checkedAt > checkedAt + 15) throw new Error('Monitor clock moved backwards');
  integer(snapshot.blockNumber);
  if (!hash(snapshot.blockHash) || checkedAt - chainTime > 180 || chainTime - checkedAt > 15) throw new Error('Stale monitoring snapshot');
  if (!Array.isArray(cases) || cases.length !== manifest.publication.draft.events.length
    || timing.observationEnds.length !== cases.length || typeof state.funded !== 'boolean'
    || typeof state.delivered !== 'boolean' || typeof state.resolved !== 'boolean'
    || state.delivered !== state.resolved) throw new Error('Invalid settlement state');
  const alerts = [];
  const add = (code, severity, message, event = null, deadline = null) => alerts.push({
    id: `${monitorIdentity(manifest)}:${event ?? 'pool'}:${code}:${deadline ?? ''}`,
    code, severity, event, deadline, message,
  });
  if (checkpointReorg) add('CHECKPOINT_REORG', 'critical', 'The previous observed block changed. Review the current state and any earlier notifications; they may describe orphaned transactions.');
  if (previous && checkedAt - previous.checkedAt > 300) add('CHECK_GAP', 'warning', 'More than five minutes elapsed since the previous successful check. Intermediate activity may have been missed.');
  if (atoms(state.poolCash) < atoms(state.requiredCollateral)) add('COLLATERAL_DEFICIT', 'critical', 'Pool collateral is below its required payout reserve. Investigate before further actions.');
  if (!state.funded) add('POOL_NOT_FUNDED', 'warning', 'The pool is not funded; resolver actions are unavailable.');
  const closesAt = integer(timing.closesAt);
  const events = cases.map((c, event) => {
    if (!phases[c.phase] || !outcomes[c.proposal] || !outcomes[c.counter] || !outcomes[c.result]
      || !Array.isArray(c.votes) || c.votes.length !== 3) throw new Error('Invalid resolver case');
    const observationEnd = integer(timing.observationEnds[event]), assertionDeadline = integer(c.assertionDeadline);
    const challengeUntil = integer(c.challengeUntil), voteUntil = integer(c.voteUntil);
    if (observationEnd <= closesAt || assertionDeadline !== observationEnd + integer(timing.assertionPeriod)
      || (c.phase === 1 && (c.proposal === 0 || challengeUntil === 0))
      || (c.phase === 2 && (c.proposal === 0 || c.counter === 0 || voteUntil === 0))
      || (c.phase === 3 && c.result === 0)) throw new Error('Invalid resolver timing');
    const votes = c.votes.map(integer);
    let action = 'Wait for the observation window to end.', deadline = observationEnd;
    if (c.phase === 3) { action = 'Outcome finalized; wait for all events and settlement delivery.'; deadline = null; }
    else if (c.phase === 0 && chainTime >= assertionDeadline) {
      action = 'A finalize transaction can record VOID because no assertion arrived in time.'; deadline = assertionDeadline;
      if (state.funded) add('ASSERTION_TIMEOUT_READY', 'warning', action, event, deadline);
    } else if (c.phase === 0 && chainTime >= observationEnd) {
      action = 'Review the committed source rules and evidence before a bonded assertion. Missing evidence is not NO.'; deadline = assertionDeadline;
      if (state.funded) add('ASSERTION_WINDOW_OPEN', 'warning', action, event, deadline);
    } else if (c.phase === 1) {
      deadline = challengeUntil;
      action = chainTime < deadline
        ? 'Review this assertion now. If incorrect, a different non-reviewer wallet must challenge before the deadline.'
        : 'The challenge window has closed. Anyone can finalize the proposal, including an incorrect unchallenged answer. Do not treat it as source-verified.';
      if (state.funded) add(chainTime < deadline ? 'ASSERTION_REVIEW_REQUIRED' : 'UNCHALLENGED_FINALIZATION_READY', 'critical', action, event, deadline);
    } else if (c.phase === 2) {
      deadline = voteUntil;
      action = chainTime < deadline
        ? 'The named reviewers must inspect both evidence sets and vote before the deadline.'
        : 'The voting window has closed without finalization. A finalize transaction can record VOID.';
      if (state.funded) add(chainTime < deadline ? 'REVIEWER_VOTES_REQUIRED' : 'VOTING_TIMEOUT_READY', 'warning', action, event, deadline);
    }
    const remainingSeconds = deadline === null ? null : deadline - chainTime;
    if (state.funded && c.phase !== 3 && remainingSeconds > 0 && remainingSeconds <= 1800) {
      add(remainingSeconds <= 600 ? 'DEADLINE_WITHIN_10_MINUTES' : 'DEADLINE_WITHIN_30_MINUTES',
        remainingSeconds <= 600 ? 'critical' : 'warning', 'The current stage deadline is approaching; check the required action and wallet eligibility.', event, deadline);
    }
    const prior = checkpointReorg ? null : previous?.cases[event];
    const changed = prior && (prior.phase !== c.phase || prior.result !== c.result || prior.votes.some((v, i) => v !== votes[i]));
    if (changed) add('CASE_CHANGED', 'info', 'Resolver phase, result or vote totals changed since the previous successful check.', event);
    return { event, question: manifest.publication.draft.events[event].question, phase: phases[c.phase],
      proposal: outcomes[c.proposal], counter: outcomes[c.counter], result: outcomes[c.result],
      asserter: c.asserter, disputer: c.disputer, evidenceHash: c.evidenceHash, counterEvidenceHash: c.counterEvidenceHash,
      votes, deadline, remainingSeconds, action };
  });
  if (state.delivered && cases.some(c => c.phase !== 3)) throw new Error('Invalid delivery state');
  if (state.funded && !state.delivered && cases.every(c => c.phase === 3)) add('DELIVERY_READY', 'warning', 'All outcomes are final. A separate deliver transaction is required before pool redemption.');
  if (state.delivered && !previous?.delivered) add('SETTLEMENT_DELIVERED', 'info', 'Outcomes were delivered to the pool. Holders can review their exact payouts and redeem; this does not validate outcome truth.');
  const report = { schema: 'flurbo.settlement-monitor.v1', checkedAt, status: alerts.some(a => a.severity !== 'info') ? 'attention_required' : 'observed',
    chainId: 10143, pool: manifest.pool, resolver: manifest.resolver, rulesHash: manifest.rulesHash, snapshot,
    lifecycle: state.delivered ? 'settled' : chainTime < closesAt ? 'trading_open' : 'trading_closed',
    timing, poolCashAtoms: String(state.poolCash), requiredCollateralAtoms: String(state.requiredCollateral), events, alerts,
    notice: 'Read-only snapshot check. No transaction or email sent. No continuous monitoring, complete event history or source-truth verification is established by this report.' };
  const checkpoint = { schema: 'flurbo.settlement-checkpoint.v1', identity: monitorIdentity(manifest), checkedAt, snapshot,
    delivered: state.delivered, cases: cases.map(c => ({ phase: c.phase, result: c.result, votes: c.votes.map(integer) })) };
  return { report, checkpoint };
}

export async function checkSettlement({ manifest, rpc, now = () => Math.floor(Date.now() / 1000), previous = null }) {
  validateMonitorCheckpoint(previous, manifest);
  const service = pilotService({ manifest, rpc, now });
  const state = await service.status();
  const tag = '0x' + BigInt(state.snapshot.blockNumber).toString(16);
  const read = async (to, abi, functionName, args = []) => decodeFunctionResult({ abi, functionName,
    data: await rpc('eth_call', [{ to, data: encodeFunctionData({ abi, functionName, args }) }, tag]) });
  // Read timing from the contracts, rather than trusting editable local dates.
  const [closesAt, count, assertionPeriod, collateral, poolCollateral, funded, quorum] = await Promise.all([
    read(manifest.resolver, resolverAbi, 'closesAt'), read(manifest.resolver, resolverAbi, 'eventCount'),
    read(manifest.resolver, resolverAbi, 'assertionPeriod'), read(manifest.resolver, resolverAbi, 'collateral'),
    read(manifest.pool, pilotPoolAbi, 'collateral'), read(manifest.pool, pilotPoolAbi, 'funded'), read(manifest.resolver, resolverAbi, 'quorum'),
  ]);
  if (Number(count) !== state.cases.length || collateral.toLowerCase() !== pilotCash || poolCollateral.toLowerCase() !== pilotCash) throw new Error('Monitor binding mismatch');
  const observationEnds = await Promise.all(state.cases.map((_, i) => read(manifest.resolver, resolverAbi, 'observationEnds', [BigInt(i)])));
  let checkpointReorg = false;
  if (previous) {
    const block = await rpc('eth_getBlockByNumber', ['0x' + BigInt(previous.snapshot.blockNumber).toString(16), false]);
    // An RPC lagging behind the checkpoint cannot certify a reorg or advance it.
    if (!block || BigInt(state.snapshot.blockNumber) < BigInt(previous.snapshot.blockNumber)) throw new Error('Previous checkpoint unavailable');
    checkpointReorg = block.hash?.toLowerCase() !== previous.snapshot.blockHash;
  }
  if ((await rpc('eth_getBlockByNumber', [tag, false]))?.hash?.toLowerCase() !== state.snapshot.blockHash) throw new Error('Monitoring snapshot changed');
  state.funded = funded;
  state.timing = { closesAt: integer(closesAt), observationEnds: observationEnds.map(integer), assertionPeriod: integer(assertionPeriod), quorum: integer(quorum) };
  return settlementReport(state, { now: now(), previous, checkpointReorg });
}
