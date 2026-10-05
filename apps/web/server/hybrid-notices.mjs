import { getAddress, parseAbi } from 'viem';
import { hybridPoolIndexes } from './hybrid-portfolio.mjs';
import { readHybridSnapshot } from './hybrid-settlement-worker.mjs';
import { hybridRealitySnapshot } from './hybrid-reality.mjs';

const poolAbi = parseAbi(['function holdings(address,uint32,uint256) view returns (uint128)',
  'function payoutFraction(uint32,uint256) view returns (uint256 numerator,uint256 denominator)']);

export function hybridNoticePools({ pools, market, source, command,
  indexes = hybridPoolIndexes({ pools, market, command }) }) {
  if (!command || !pools?.length) return [];
  return pools.map(record => {
    async function refresh() {
      const index = indexes.get(record.pool.toLowerCase());
      if (!index) throw Error('Hybrid history unavailable');
      return index.history.refresh();
    }
    const href = event => `/markets/hybrid/${record.pool}/${event}`;
    return { namespace: `hybrid:${record.pool.toLowerCase()}`,
      label: record.prepared.draft.title,
      service: { manifest: { pool: record.pool.toLowerCase(),
        publication: { draft: record.prepared.draft } },
      index: { refresh }, eventHref: href, payoutHref: href(0),
      async status() {
        const snapshot = await readHybridSnapshot(record, market);
        const cases = await Promise.all(snapshot.states.map(async (state, event) => {
          if (record.prepared.draft.events[event].route === 'mechanical')
            return { phase: Number(state.phase), proposal: Number(state.proposal),
              challengeUntil: Number(state.challengeUntil) };
          const reality = await hybridRealitySnapshot(source, record.prepared.draft.events[event]);
          return { phase: !reality.finalized && !reality.pendingArbitration
              && BigInt(reality.bondWei) > 0n && reality.sourceNow < reality.finalizesAt ? 1 : 0,
            proposal: { No: 1, Yes: 2, Void: 3 }[reality.answerLabel] || 0,
            challengeUntil: reality.finalizesAt,
            court: reality.disputeStatus > 0 ? { disputeId: reality.disputeId, status: reality.disputeStatus } : null };
        }));
        return { resolved: snapshot.resolved, delivered: snapshot.delivered,
          cases };
      },
      async positions(wallet, claims) {
        const snapshot = await readHybridSnapshot(record, market);
        const rows = await Promise.all(claims.map(async claim => {
          const quantity = await market.readContract({ address: getAddress(record.pool), abi: poolAbi,
            functionName: 'holdings', args: [getAddress(wallet), claim.scope, BigInt(claim.mask)] });
          let payoutAtoms = null;
          if (snapshot.resolved && quantity > 0n) {
            const [num, den] = await market.readContract({ address: getAddress(record.pool),
              abi: poolAbi, functionName: 'payoutFraction', args: [claim.scope, BigInt(claim.mask)] });
            payoutAtoms = (quantity * BigInt(num) / BigInt(den)).toString();
          }
          return { ...claim, quantity: quantity.toString(), payoutAtoms };
        }));
        return { rows };
      } },
    };
  });
}
