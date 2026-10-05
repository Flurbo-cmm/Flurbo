import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPublicClient, getAddress, http } from 'viem';
import { klerosCourtSnapshot } from '../server/hybrid-reality.mjs';
import { courtAbi, proxyAbi, SEPOLIA_KLEROS } from '../server/oracle-integration.mjs';

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const statusLabel = ['none', 'disputed', 'ruled', 'reported'];

export async function klerosDisputeReport(client, { questionId, juror }) {
  const request = await client.readContract({ address: getAddress(SEPOLIA_KLEROS), abi: proxyAbi,
    functionName: 'arbitrationRequests', args: [BigInt(questionId)] });
  const proxyStatus = Number(request[0]);
  if (proxyStatus === 0) return { status: 'none' };
  const court = await klerosCourtSnapshot(client, SEPOLIA_KLEROS, request[2]);
  const voteIds = [];
  for (let id = 0; id < court.votesNeeded; id++) {
    const vote = await client.readContract({ address: court.court, abi: courtAbi, functionName: 'getVote',
      args: [BigInt(court.disputeId), BigInt(court.rounds - 1), BigInt(id)] });
    if (same(vote[0], juror)) voteIds.push(id);
  }
  return { status: statusLabel[proxyStatus], proxyStatus, disputeId: court.disputeId, period: court.periodLabel,
    voteIds, choices: { No: 1, Yes: 2, Void: 0 },
    castVoteCommand: `cast send ${court.court} 'castVote(uint256,uint256[],uint256,uint256)' ${court.disputeId} '[${voteIds.join(',')}]' <CHOICE> 0 --rpc-url "$FLURBO_SEPOLIA_RPC_URL" --account flurbo-kleros-juror` };
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
