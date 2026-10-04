import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeAbiParameters, parseAbiParameters } from 'viem';
import { prepareWidePilot } from '../scripts/prepare-wide-pilot.mjs';

const addr = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const hash = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const event = (n: number) => ({
  id: `question-${n}`, question: `Did fixture ${n} finish?`, observationEndsAt: 11_000,
  source: { kind: 'reality-sepolia', chainId: 11155111, reality: addr(100),
    arbitrator: addr(101), questionId: hash(n + 1), contentHash: hash(n + 100),
    minTimeout: 3600, minBond: '1000' },
});
const input = {
  schema: 'flurbo.wide-publication.v3', chainId: 10143, trustModel: 'trusted-source-relay',
  rulesReviewed: true, creator: addr(1), title: 'Isolated wide test', closesAt: 10_000,
  events: Array.from({ length: 32 }, (_, i) => event(i)), relay: addr(2),
  liquidityAtoms: '250000000', reportPeriod: 86400,
};
const abi = parseAbiParameters('(address collateral, bytes32 draftHash, uint64 closesAt, bytes32[] eventHashes, uint64[] observationEnds, address relay, uint32 reportPeriod) config');

test('prepares 32 distinct committed Reality events for a new resolver', () => {
  const prepared = prepareWidePilot(input, 1000);
  const [config] = decodeAbiParameters(abi, prepared.resolverConfig);
  assert.equal(prepared.eventHashes.length, 32);
  assert.equal(config.eventHashes.length, 32);
  assert.equal(config.relay.toLowerCase(), input.relay);
  assert.equal(config.reportPeriod, 86400);
  assert.equal(config.eventHashes[31], prepared.eventHashes[31]);
  const edited = structuredClone(input);
  edited.events[31].source.questionId = hash(99);
  assert.notEqual(prepareWidePilot(edited, 1000).draftHash, prepared.draftHash);
  assert.throws(() => prepareWidePilot({ ...input, events: [...input.events, event(32)] }, 1000), /Invalid wide publication/);
  assert.throws(() => prepareWidePilot({ ...input, events: [event(0), event(0)] }, 1000), /duplicate event/);
  assert.throws(() => prepareWidePilot({ ...input, reviewers: [addr(3), addr(4), addr(5)] }, 1000), /Invalid wide publication/);
});
