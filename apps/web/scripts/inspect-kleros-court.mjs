import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPublicClient, encodeAbiParameters, getAddress, http, keccak256, parseAbiParameters, toHex } from 'viem';
import { verifyKlerosProxy } from '../server/hybrid-reality.mjs';
import { courtAbi, KLEROS_PROXY_CODE_HASH, proxyAbi } from '../server/oracle-integration.mjs';

export const SORTITION_TREES_SLOT = 11n;
const zero = `0x${'0'.repeat(64)}`;

export function sortitionRootSlot(subcourtId) {
  const base = BigInt(keccak256(encodeAbiParameters(parseAbiParameters('bytes32,uint256'),
    [toHex(BigInt(subcourtId), { size: 32 }), SORTITION_TREES_SLOT])));
  return keccak256(toHex(base + 2n, { size: 32 }));
}

export async function klerosJurorReadiness(client, { proxy, juror, proxyCodeHash = KLEROS_PROXY_CODE_HASH }) {
  if (await client.getChainId() !== 11155111) throw Error('Sepolia RPC required');
  const checked = await verifyKlerosProxy(client, proxy, proxyCodeHash);
  const readCourt = (functionName, args = []) => client.readContract({ address: checked.court,
    abi: courtAbi, functionName, args });
  const [subcourt, jurorStake, locked, phase, nextDelayed, lastDelayed, fee, rootValue] = await Promise.all([
    readCourt('courts', [BigInt(checked.subcourtId)]),
    readCourt('stakeOf', [getAddress(juror), BigInt(checked.subcourtId)]),
    readCourt('jurors', [getAddress(juror)]),
    readCourt('phase'), readCourt('nextDelayedSetStake'), readCourt('lastDelayedSetStake'),
    client.readContract({ address: checked.proxy, abi: proxyAbi, functionName: 'getDisputeFee', args: [zero] }),
    client.getStorageAt({ address: checked.court, slot: sortitionRootSlot(checked.subcourtId) }),
  ]);
  const minStake = BigInt(subcourt[2]), stake = BigInt(jurorStake), treeTotal = BigInt(rootValue || '0x0');
  return { proxy: checked.proxy, court: checked.court, subcourtId: checked.subcourtId,
    minJurors: checked.minJurors, feeWei: BigInt(fee).toString(), minStakeWei: minStake.toString(),
    jurorStakeWei: stake.toString(), lockedWei: BigInt(locked[1]).toString(), treeTotalWei: treeTotal.toString(),
    sharePercent: treeTotal === 0n ? '0.00' : (Number(stake * 10000n / treeTotal) / 100).toFixed(2),
    phase: Number(phase), delayedStakesPending: BigInt(lastDelayed) >= BigInt(nextDelayed),
    ready: stake > 0n && stake >= minStake && stake === treeTotal };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [proxy, juror] = process.argv.slice(2);
  const rpc = process.env.FLURBO_SEPOLIA_RPC_URL;
  if (!/^0x[0-9a-fA-F]{40}$/.test(proxy || '') || !/^0x[0-9a-fA-F]{40}$/.test(juror || '')
    || !rpc?.startsWith('https://'))
    throw Error('Usage: set FLURBO_SEPOLIA_RPC_URL, then node inspect-kleros-court.mjs PROXY JUROR_ADDRESS');
  const report = await klerosJurorReadiness(createPublicClient({ transport: http(rpc) }), { proxy, juror });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ready ? 0 : 1;
}
