import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getAddress } from 'viem';
import { prepareHybridPilot } from './prepare-hybrid-pilot.mjs';

const RPC = 'https://testnet-rpc.monad.xyz/';

export function createHybridEvmPilot({ creator, proposer, relay, closesAt }) {
  const addresses = [creator, proposer, relay].map(address => getAddress(address));
  if (new Set(addresses.map(address => address.toLowerCase())).size !== 3
    || !Number.isSafeInteger(closesAt)
    || closesAt < Math.floor(Date.now() / 1000) + 7200
    || closesAt > Math.floor(Date.now() / 1000) + 14 * 86400)
    throw Error('Choose three distinct wallets and a close time 2 hours to 14 days away');
  const [deployer, proposerWallet, relayWallet] = addresses;
  const target = closesAt + 600, scheduledAt = target + 120;
  const observationEndsAt = target + 1800;
  const targetIso = new Date(target * 1000).toISOString().replace('.000Z', 'Z');
  const specifications = [
    { id: 'monad-block-transactions', field: 'transactions', threshold: '1', unit: 'transactions',
      question: `Will the first Monad testnet block at or after ${targetIso} contain at least one transaction, as read from the public Monad RPC?` },
    { id: 'monad-block-gas', field: 'gasUsed', threshold: '1000000', unit: 'gas',
      question: `Will the first Monad testnet block at or after ${targetIso} use at least 1000000 gas units, as read from the public Monad RPC?` },
  ];
  const events = specifications.map(spec => {
    const rule = { schema: 'flurbo.settlement-rule.v1', eventId: spec.id,
      question: spec.question,
      source: { id: 'monad-testnet-first-block', publisher: 'Monad testnet RPC',
        urls: [RPC], adapter: 'evm-rpc.v1', reader: { chainId: 10143, at: target,
          metric: 'block-field', field: spec.field, finalitySeconds: 60 } },
      observation: { series: spec.id, period: targetIso, unit: spec.unit },
      decision: { type: 'number', operator: 'gte', value: spec.threshold },
      timing: { scheduledAt, publicationCutoff: observationEndsAt,
        correctionCutoff: observationEndsAt, observationEndsAt,
        assertionPeriod: 3600, challengePeriod: 3600, votingPeriod: 3600 },
      vintage: 'first-observed-snapshot', missingPolicy: 'resolver-timeout-void' };
    return { id: spec.id, question: spec.question, observationEndsAt,
      route: 'mechanical', rule };
  });
  const draft = { schema: 'flurbo.hybrid-publication.v4', chainId: 10143,
    rulesReviewed: true, creator: deployer, proposer: proposerWallet, relay: relayWallet,
    title: 'Monad testnet source reader pool', closesAt,
    assertionPeriod: 3600, challengePeriod: 3600, reportPeriod: 90 * 86400,
    arbitrationPeriod: 90 * 86400, bondAtoms: '1000000',
    liquidityAtoms: '10000000', events };
  prepareHybridPilot(draft);
  return draft;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [creator, proposer, relay, close, output] = process.argv.slice(2);
  if (!output || !/^[1-9]\d*$/.test(close || ''))
    throw Error('Usage: node create-hybrid-evm-pilot.mjs CREATOR PROPOSER RELAY CLOSE_UNIX OUTPUT.json');
  const draft = createHybridEvmPilot({ creator, proposer, relay, closesAt: Number(close) });
  await writeFile(output, JSON.stringify(draft, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: 'draft_created', events: draft.events.length,
    closesAt: draft.closesAt, observationEndsAt: draft.events[0].observationEndsAt,
    output }));
}
