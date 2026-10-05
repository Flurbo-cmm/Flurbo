import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPublicClient, getAddress, http } from 'viem';
import { castVoteCommand, klerosCourtSnapshot } from '../server/hybrid-reality.mjs';
import { courtAbi, hybridArbitrator, proxyAbi, realityAbi, SEPOLIA_REALITY } from '../server/oracle-integration.mjs';

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const statusLabel = ['none', 'disputed', 'ruled', 'reported'];

export async function klerosDisputeReport(client, { questionId, juror, reality = SEPOLIA_REALITY }) {
  const proxy = await client.readContract({ address: getAddress(reality), abi: realityAbi,
    functionName: 'getArbitrator', args: [questionId] });
  if (!hybridArbitrator(proxy)) throw Error('Question arbitrator is not a supported Kleros proxy');
  const request = await client.readContract({ address: getAddress(proxy), abi: proxyAbi,
    functionName: 'arbitrationRequests', args: [BigInt(questionId)] });
  const proxyStatus = Number(request[0]);
  if (proxyStatus === 0) return { status: 'none' };
  const court = await klerosCourtSnapshot(client, proxy, request[2]);
  const voteIds = [];
  for (let id = 0; id < court.votesNeeded; id++) {
    const vote = await client.readContract({ address: court.court, abi: courtAbi, functionName: 'getVote',
      args: [BigInt(court.disputeId), BigInt(court.rounds - 1), BigInt(id)] });
    if (same(vote[0], juror)) voteIds.push(id);
  }
  return { status: statusLabel[proxyStatus], proxyStatus, proxy: getAddress(proxy), subcourtId: court.subcourtId,
    disputeId: court.disputeId, period: court.periodLabel, voteIds, choices: { No: 1, Yes: 2, Void: 0 },
    castVoteCommand: castVoteCommand(court.court, court.disputeId, voteIds) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [questionId, juror] = process.argv.slice(2);
  const rpc = process.env.FLURBO_SEPOLIA_RPC_URL;
  if (!/^0x[0-9a-fA-F]{64}$/.test(questionId || '') || !/^0x[0-9a-fA-F]{40}$/.test(juror || '')
    || !rpc?.startsWith('https://'))
    throw Error('Usage: set FLURBO_SEPOLIA_RPC_URL, then node inspect-kleros-dispute.mjs QUESTION_ID JUROR_ADDRESS');
  const client = createPublicClient({ transport: http(rpc) });
  if (await client.getChainId() !== 11155111) throw Error('Sepolia RPC required');
  console.log(JSON.stringify(await klerosDisputeReport(client, { questionId, juror }), null, 2));
}
