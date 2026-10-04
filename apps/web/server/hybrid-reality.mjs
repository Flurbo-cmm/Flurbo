import { encodeFunctionData, formatEther, getAddress, parseEther } from 'viem';
import { answerEvent, courtAbi, proxyAbi, realityAbi } from './oracle-integration.mjs';

const zero = `0x${'0'.repeat(64)}`;
const answers = { no: zero, yes: `0x${'0'.repeat(63)}1`, void: `0x${'f'.repeat(64)}` };
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

export async function hybridRealitySnapshot(source, event, owner = null) {
  const details = event.source;
  if (await source.getChainId() !== 11155111) throw Error('Reality RPC is not Sepolia');
  const reality = getAddress(details.reality), arbitrator = getAddress(details.arbitrator);
  const read = (address, abi, functionName, args = []) => source.readContract({ address,
    abi, functionName, args });
  const q = details.questionId, args = [q];
  const [contentHash, chosenArbitrator, opening, timeout, minBond, bond, finalizesAt,
    bestAnswer, historyHash, pendingArbitration, finalized, disputeFee, proxyReality,
    dispute, credit, block] = await Promise.all([
    read(reality, realityAbi, 'getContentHash', args),
    read(reality, realityAbi, 'getArbitrator', args),
    read(reality, realityAbi, 'getOpeningTS', args),
    read(reality, realityAbi, 'getTimeout', args),
    read(reality, realityAbi, 'getMinBond', args),
    read(reality, realityAbi, 'getBond', args),
    read(reality, realityAbi, 'getFinalizeTS', args),
    read(reality, realityAbi, 'getBestAnswer', args),
    read(reality, realityAbi, 'getHistoryHash', args),
    read(reality, realityAbi, 'isPendingArbitration', args),
    read(reality, realityAbi, 'isFinalized', args),
    read(arbitrator, proxyAbi, 'getDisputeFee', args),
    read(arbitrator, proxyAbi, 'realitio'),
    read(arbitrator, proxyAbi, 'arbitrationRequests', [BigInt(q)]),
    owner ? read(reality, realityAbi, 'balanceOf', [getAddress(owner)]) : 0n,
    source.getBlock(),
  ]);
  if (!same(contentHash, details.contentHash) || !same(chosenArbitrator, arbitrator)
    || !same(proxyReality, reality) || Number(opening) !== event.observationEndsAt
    || Number(timeout) < details.minTimeout || BigInt(minBond) < BigInt(details.minBond)
    || !Number.isSafeInteger(Number(block.timestamp)))
    throw Error('Reality question differs from the published source');
  const nextBond = [BigInt(minBond), BigInt(bond) * 2n, 1n]
    .reduce((a, b) => a > b ? a : b);
  return { chainId: 11155111, reality, arbitrator, questionId: q,
    sourceNow: Number(block.timestamp), opensAt: Number(opening),
    finalizesAt: Number(finalizesAt), bondWei: BigInt(bond).toString(),
    nextBondWei: nextBond.toString(), disputeFeeWei: BigInt(disputeFee).toString(),
    pendingArbitration, finalized, creditedEthWei: BigInt(credit).toString(),
    historyHash, disputeStatus: Number(dispute[0]),
    disputeId: BigInt(dispute[2]).toString(),
    answerLabel: BigInt(bond) === 0n ? null : same(bestAnswer, answers.no) ? 'No'
      : same(bestAnswer, answers.yes) ? 'Yes' : same(bestAnswer, answers.void) ? 'Void' : 'Unsupported answer' };
}

async function answerHistory(source, event) {
  const receipt = await source.getTransactionReceipt({ hash: event.source.questionTxHash });
  if (receipt.status !== 'success' || !same(receipt.to, event.source.reality))
    throw Error('Reality question transaction mismatch');
  const latest = await source.getBlockNumber();
  if (latest < receipt.blockNumber || latest - receipt.blockNumber > 1_000_000n)
    throw Error('Reality answer history exceeds supported scan');
  const logs = [];
  for (let from = receipt.blockNumber; from <= latest; from += 2000n) {
    const to = from + 1999n < latest ? from + 1999n : latest;
    logs.push(...await source.getLogs({ address: getAddress(event.source.reality),
      event: answerEvent, args: { question_id: event.source.questionId },
      fromBlock: from, toBlock: to }));
  }
  return logs.map(log => log.args);
}

export async function hybridRealityReportAction(source, event, owner, state) {
  if (!state.pendingArbitration || state.disputeStatus !== 3)
    throw Error('Kleros ruling is not ready to report');
  const logs = await answerHistory(source, event);
  const last = logs.at(-1), previous = logs.at(-2)?.history_hash || zero;
  if (!last || !same(last.history_hash, state.historyHash)
    || BigInt(last.bond) !== BigInt(state.bondWei)
    || !/^0x[0-9a-f]{40}$/i.test(last.user)
    || !/^0x[0-9a-f]{64}$/i.test(last.answer))
    throw Error('Reality answer history mismatch');
  const args = [state.questionId, previous, last.answer, getAddress(last.user)];
  await source.simulateContract({ address: getAddress(state.arbitrator), abi: proxyAbi,
    functionName: 'reportAnswer', args, account: getAddress(owner) });
  return { action: 'finalizeArbitration', reason: 'Report the final Kleros ruling to Reality.eth',
    transaction: { chainId: 11155111, from: getAddress(owner), to: getAddress(state.arbitrator),
      data: encodeFunctionData({ abi: proxyAbi, functionName: 'reportAnswer', args }), value: '0x0' } };
}

export async function hybridRealityClaimAction(source, event, owner, state) {
  if (!state.finalized || same(state.historyHash, zero))
    throw Error('Reality bonds are not ready to claim');
  const logs = await answerHistory(source, event);
  const current = logs.findLastIndex(log => same(log.history_hash, state.historyHash));
  if (current < 0) throw Error('Reality answer history mismatch');
  if (!logs.slice(0, current + 1).some(log => same(log.user, owner)))
    throw Error('This wallet did not post an answer bond');
  const selected = [];
  for (let index = current; index >= 0 && selected.length < 32; index--) {
    const item = logs[index];
    if (!/^0x[0-9a-f]{40}$/i.test(item.user) || !/^0x[0-9a-f]{64}$/i.test(item.answer)
      || !/^0x[0-9a-f]{64}$/i.test(item.history_hash))
      throw Error('Reality answer history mismatch');
    selected.push({ previous: index === 0 ? zero : logs[index - 1].history_hash,
      user: getAddress(item.user), bond: BigInt(item.bond), answer: item.answer });
  }
  const args = [state.questionId, selected.map(item => item.previous),
    selected.map(item => item.user), selected.map(item => item.bond),
    selected.map(item => item.answer)];
  await source.simulateContract({ address: getAddress(state.reality), abi: realityAbi,
    functionName: 'claimWinnings', args, account: getAddress(owner) });
  return { action: 'claimWinnings', reason: 'Process Reality answer bonds and credit eligible winners',
    transaction: { chainId: 11155111, from: getAddress(owner), to: getAddress(state.reality),
      data: encodeFunctionData({ abi: realityAbi, functionName: 'claimWinnings', args }), value: '0x0' } };
}

export function hybridRealityAction(id, action, input, owner, state) {
  const tx = (to, functionName, abi, args = [], value = 0n) => ({
    chainId: 11155111, from: getAddress(owner), to: getAddress(to),
    data: encodeFunctionData({ abi, functionName, args }), value: `0x${value.toString(16)}` });
  if (action === 'answer') {
    if (!Object.hasOwn(answers, input?.answer)
      || typeof input?.bondEth !== 'string'
      || !/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(input.bondEth))
      throw Error('Enter a valid answer and Sepolia ETH bond');
    if (state.finalized || state.pendingArbitration || state.sourceNow < state.opensAt
      || BigInt(state.bondWei) > 0n && state.sourceNow >= state.finalizesAt)
      throw Error('Reality answer window closed');
    const amount = parseEther(input.bondEth);
    if (amount < BigInt(state.nextBondWei)) throw Error('Bond must meet the current minimum');
    return { action, reason: `Post ${input.answer.toUpperCase()} with ${input.bondEth} Sepolia ETH bond`,
      transaction: tx(state.reality, 'submitAnswer', realityAbi,
        [state.questionId, answers[input.answer], BigInt(state.bondWei)], amount) };
  }
  if (action === 'arbitrate') {
    if (state.finalized || state.pendingArbitration || BigInt(state.bondWei) === 0n
      || state.sourceNow >= state.finalizesAt)
      throw Error('Kleros challenge window closed');
    const fee = BigInt(state.disputeFeeWei);
    if (fee <= 0n) throw Error('Kleros arbitration fee unavailable');
    return { action, reason: `Request Kleros arbitration for ${formatEther(fee)} Sepolia ETH`,
      transaction: tx(state.arbitrator, 'requestArbitration', proxyAbi,
        [state.questionId, BigInt(state.bondWei)], fee) };
  }
  if (action === 'withdrawReality') {
    if (BigInt(state.creditedEthWei) <= 0n) throw Error('No Reality bond credit to withdraw');
    return { action, reason: `Withdraw ${formatEther(BigInt(state.creditedEthWei))} Sepolia ETH bond credit`,
      transaction: tx(state.reality, 'withdraw', realityAbi) };
  }
  throw Error(`Unsupported Reality action for ${id}`);
}

export async function hybridRealityAppealAction(source, action, input, owner, state) {
  if (![0, 1, 2].includes(input?.ruling)) throw Error('Select a Kleros ruling');
  let amount = 0n, functionName, args;
  if (action === 'appeal') {
    if (!state.pendingArbitration || state.disputeStatus !== 2)
      throw Error('No appealable Kleros dispute');
    const court = await source.readContract({ address: getAddress(state.arbitrator), abi: proxyAbi,
      functionName: 'arbitrator' });
    const [start, end] = await source.readContract({ address: getAddress(court), abi: courtAbi,
      functionName: 'appealPeriod', args: [BigInt(state.disputeId)] });
    if (state.sourceNow < Number(start) || state.sourceNow >= Number(end))
      throw Error('Kleros appeal window closed');
    if (typeof input.amountEth !== 'string'
      || !/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(input.amountEth))
      throw Error('Enter a valid Sepolia ETH contribution');
    amount = parseEther(input.amountEth);
    if (amount <= 0n) throw Error('Appeal contribution must be positive');
    functionName = 'fundAppeal'; args = [BigInt(state.questionId), BigInt(input.ruling)];
  } else if (action === 'claimAppeal') {
    if (state.disputeStatus < 2) throw Error('No Kleros appeal rewards available');
    const available = await source.readContract({ address: getAddress(state.arbitrator),
      abi: proxyAbi, functionName: 'getTotalWithdrawableAmount',
      args: [BigInt(state.questionId), getAddress(owner), BigInt(input.ruling)] });
    if (available <= 0n) throw Error('No appeal rewards available');
    functionName = 'withdrawFeesAndRewardsForAllRounds';
    args = [BigInt(state.questionId), getAddress(owner), BigInt(input.ruling)];
  } else throw Error('Unsupported Kleros action');
  await source.simulateContract({ address: getAddress(state.arbitrator), abi: proxyAbi,
    functionName, args, account: getAddress(owner), value: amount });
  return { action, reason: action === 'appeal'
    ? `Contribute ${input.amountEth} Sepolia ETH to the Kleros appeal`
    : 'Claim Kleros appeal rewards',
  transaction: { chainId: 11155111, from: getAddress(owner), to: getAddress(state.arbitrator),
    data: encodeFunctionData({ abi: proxyAbi, functionName, args }), value: `0x${amount.toString(16)}` } };
}
