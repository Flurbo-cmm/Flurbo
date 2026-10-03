// Read-only measurement of end-to-end settlement latency: from the moment an automatic action became
// possible on-chain (readyAt) to the block that included it (confirmedAt). Uses historical state reads only.
// Proposal time is exact from the contract (challengeUntil = block.timestamp + challengePeriod); finalization
// and delivery are located by binary search over historical state. Quorum votes are human actions: excluded.
import { decodeFunctionResult, encodeFunctionData } from 'viem';
import { resolverAbi } from '../shared/pilot.mjs';

const ZERO = '0x0000000000000000000000000000000000000000';

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

export async function measureSettlement({ manifest, rpc, signer = null }) {
  const hex = n => '0x' + BigInt(n).toString(16);
  const read = async (functionName, args = [], tag = 'latest') => decodeFunctionResult({ abi: resolverAbi, functionName,
    data: await rpc('eth_call', [{ to: manifest.resolver, data: encodeFunctionData({ abi: resolverAbi, functionName, args }) }, tag]) });
  const block = async n => {
    const b = await rpc('eth_getBlockByNumber', [n === 'latest' ? 'latest' : hex(n), false]);
    if (!b?.number || !b?.timestamp) throw new Error('Block unavailable');
    return { number: Number(BigInt(b.number)), timestamp: Number(BigInt(b.timestamp)) };
  };
  const head = await block('latest');
  // First block at or after a timestamp. Block times are monotonic.
  const blockAt = async timestamp => {
    let lo = 0, hi = head.number;
    if (timestamp > head.timestamp) return null;
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if ((await block(mid)).timestamp >= timestamp) hi = mid; else lo = mid + 1; }
    return lo;
  };
  // First block in [from, head] where the predicate holds, assuming it stays true once true.
  const firstTrue = async (from, predicate) => {
    let lo = from, hi = head.number;
    if (!(await predicate(hi))) return null;
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (await predicate(mid)) hi = mid; else lo = mid + 1; }
    return { number: lo, timestamp: (await block(lo)).timestamp };
  };
  const [challengePeriod, votingPeriod, delivered] = await Promise.all([read('challengePeriod'), read('votingPeriod'), read('delivered')]);
  const actions = [];
  const finalizedAt = [];
  for (let event = 0; event < manifest.publication.draft.events.length; event++) {
    const c = await read('caseState', [event]), observationEnd = manifest.publication.draft.events[event].observationEndsAt;
    const asserted = c.asserter.toLowerCase() !== ZERO, disputed = c.disputer.toLowerCase() !== ZERO;
    const actor = address => signer && address.toLowerCase() === signer.toLowerCase() ? 'bot' : 'other';
    if (asserted) {
      const at = Number(c.challengeUntil) - Number(challengePeriod);
      actions.push({ event, action: 'assert', actor: actor(c.asserter), readyAt: observationEnd, confirmedAt: at, latencySeconds: at - observationEnd });
    }
    if (Number(c.phase) !== 3) continue;
    const votes = c.votes.reduce((a, v) => a + Number(v), 0);
    let readyAt, path;
    if (!asserted) { readyAt = Number(await read('assertionDeadline', [event])); path = 'assertion-timeout'; }
    else if (!disputed) { readyAt = Number(c.challengeUntil); path = 'uncontested'; }
    else if (votes > 0 && Number(c.result) !== 3) { path = 'quorum'; readyAt = null; }
    else { readyAt = Number(c.voteUntil); path = 'vote-timeout'; }
    const from = readyAt === null ? 0 : await blockAt(readyAt);
    const found = await firstTrue(from ?? 0, async n => Number((await read('caseState', [event], hex(n))).phase) === 3);
    if (!found) continue;
    finalizedAt.push(found.timestamp);
    if (readyAt !== null) actions.push({ event, action: 'finalize', path, readyAt, confirmedAt: found.timestamp, block: found.number, latencySeconds: found.timestamp - readyAt });
  }
  if (delivered && finalizedAt.length === manifest.publication.draft.events.length) {
    const readyAt = Math.max(...finalizedAt);
    const found = await firstTrue(await blockAt(readyAt), async n => (await read('delivered', [], hex(n))) === true);
    if (found) actions.push({ event: null, action: 'deliver', readyAt, confirmedAt: found.timestamp, block: found.number, latencySeconds: found.timestamp - readyAt });
  }
  const summary = {};
  for (const kind of ['assert', 'finalize', 'deliver']) {
    const values = actions.filter(a => a.action === kind).map(a => a.latencySeconds);
    if (values.length) summary[kind] = { count: values.length, p50: percentile(values, 50), p99: percentile(values, 99), max: Math.max(...values) };
  }
  return { pool: manifest.pool, measuredAtBlock: head.number, actions, summary };
}
