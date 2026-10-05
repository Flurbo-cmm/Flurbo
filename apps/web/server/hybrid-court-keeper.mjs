import { createWalletClient, defineChain, getAddress, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { hybridSettlementCatalog } from './hybrid-settlement-worker.mjs';
import { hybridRealitySnapshot, klerosCourtPhase, klerosCourtSnapshot, realityReportArgs } from './hybrid-reality.mjs';
import { ARBITRATION_STATUS, courtAbi, proxyAbi } from './oracle-integration.mjs';

const sepolia = defineChain({ id: 11155111, name: 'Sepolia', nativeCurrency: {
  name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://ethereum-sepolia-rpc.publicnode.com'] } } });
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const hash32 = value => /^0x[0-9a-fA-F]{64}$/.test(value || '');
const outcomeLabel = ['', 'No', 'Yes', 'Void'];
const publicErrors = new Set(['Hybrid court keeper chain mismatch', 'Sepolia keeper needs the arbitration fee and gas',
  'Hybrid court transaction reverted', 'Hybrid court transaction hash invalid', 'Kleros ruling is not ready to report',
  'Reality answer history mismatch', 'Reality question differs from the published source']);
const safeError = error => publicErrors.has(error?.message) ? error.message
  : 'Hybrid court keeper source or transaction request failed';

export function courtAction({ now, court, phase, voteWaitSeconds }) {
  const times = court.timesPerPeriod, elapsed = now - court.lastPeriodChange;
  if (court.ruled) return { kind: 'wait', reason: 'ruled' };
  if (court.period === 0 && court.drawn < court.votesNeeded) {
    if (phase.phase === 0) {
      if (phase.lastDelayed >= phase.nextDelayed)
        return { kind: 'executeDelayedSetStakes', iterations: Math.min(phase.lastDelayed - phase.nextDelayed + 1, 20) };
      if (now - phase.lastPhaseChange >= phase.minStakingTime && phase.disputesWithoutJurors > 0)
        return { kind: 'passPhase' };
      return { kind: 'wait', reason: 'staking' };
    }
    if (phase.phase === 1) return { kind: 'passPhase' };
    return { kind: 'drawJurors', iterations: court.votesNeeded - court.drawn };
  }
  if (court.period === 0)
    return court.rounds > 1 || elapsed >= times[0] ? { kind: 'passPeriod' } : { kind: 'wait', reason: 'evidence' };
  if (court.period === 1)
    return elapsed >= times[1] ? { kind: 'passPeriod' } : { kind: 'wait', reason: 'commit' };
  if (court.period === 2)
    return court.votesCast === court.votesNeeded || elapsed >= Math.max(times[2], voteWaitSeconds)
      ? { kind: 'passPeriod' } : { kind: 'wait', reason: 'vote' };
  if (court.period === 3)
    return elapsed >= times[3] ? { kind: 'passPeriod' } : { kind: 'wait', reason: 'appeal' };
  return { kind: 'executeRuling' };
}

export function hybridCourtKeeper({ pools, source, command, evidence, rpcUrl, privateKey,
  maxDisputeFeeWei = 20_000_000_000_000_000n, voteWaitSeconds = 86_400, keeperWallet = null,
  intervalMs = 60_000 }) {
  if (!Array.isArray(pools) || !pools.length || !source || typeof command !== 'function' || !evidence?.put
    || !rpcUrl?.startsWith('https://') || !/^0x[0-9a-fA-F]{64}$/.test(privateKey || ''))
    throw Error('Hybrid court keeper configuration incomplete');
  hybridSettlementCatalog({ schema: 'flurbo.hybrid-catalog.v1', pools });
  const account = privateKeyToAccount(privateKey);
  if (pools.some(pool => !same(pool.keeper, account.address)))
    throw Error('Hybrid court keeper differs from catalog');
  const wallet = keeperWallet || createWalletClient({ account, chain: sepolia,
    transport: http(rpcUrl, { timeout: 20_000 }) });
  const routes = pools.flatMap(pool => pool.prepared.draft.events.flatMap((event, eventIndex) =>
    event.route === 'reality' ? [{ id: `${pool.pool}-${eventIndex}`, record: pool, event, eventIndex,
      questionId: event.source.questionId.toLowerCase() }] : []));
  const results = new Map(), errors = new Map();
  let timer = null, running = false, cycles = 0, lastError = null, lastFinishedAt = null;

  async function send(suffix, build) {
    const journal = `flurbo:hybrid-court:v1:${suffix}`, saved = await command('GET', journal);
    if (saved === 'preparing') return 'pending';
    if (saved) {
      const receipt = await source.getTransactionReceipt({ hash: saved }).catch(() => null);
      if (!receipt) return 'pending';
      if (receipt.status !== 'success') {
        await command('DEL', journal);
        throw Error('Hybrid court transaction reverted');
      }
      return 'confirmed';
    }
    const request = { account, chain: sepolia, ...await build() };
    await source.simulateContract(request);
    if (await command('SET', journal, 'preparing', 'EX', 1800, 'NX') !== 'OK') return 'pending';
    const hash = await wallet.writeContract(request);
    if (!hash32(hash)) throw Error('Hybrid court transaction hash invalid');
    await command('SET', journal, hash, 'EX', 86400);
    return 'submitted';
  }

  async function step(route) {
    const { event, questionId: q } = route, proxy = getAddress(event.source.arbitrator);
    const state = await hybridRealitySnapshot(source, event, null);
    const summary = { proxyStatus: state.disputeStatus, disputeId: null, period: null, waiting: null };
    results.set(route.id, summary);
    if (state.finalized) return;
    const stored = await command('GET', `flurbo:hybrid-answer:v1:${q}:observation`);
    const observation = JSON.parse(stored || 'null');
    const proxyRequest = (functionName, args, value) => ({ address: proxy, abi: proxyAbi, functionName,
      args, ...(value === undefined ? {} : { value }) });
    if (state.disputeStatus === ARBITRATION_STATUS.None) {
      if (!observation || BigInt(state.bondWei) === 0n || state.pendingArbitration
        || state.sourceNow >= state.finalizesAt - 60 || same(state.bestAnswer, observation.answer)) return;
      const fee = BigInt(state.disputeFeeWei);
      if (fee <= 0n || fee > maxDisputeFeeWei || await source.getBalance({ address: account.address }) <= fee)
        throw Error('Sepolia keeper needs the arbitration fee and gas');
      await send(`${q}:none:arbitrate`, () => proxyRequest('requestArbitration', [q, BigInt(state.bondWei)], fee));
      return;
    }
    if (state.disputeStatus === ARBITRATION_STATUS.Ruled) {
      await send(`${q}:${state.disputeId}:report`, async () =>
        proxyRequest('reportAnswer', await realityReportArgs(source, event, state)));
      return;
    }
    if (state.disputeStatus !== ARBITRATION_STATUS.Disputed) return;
    summary.disputeId = state.disputeId;
    if (observation) {
      const result = await send(`${q}:${state.disputeId}:evidence`, async () => {
        const doc = await evidence.put({ questionId: q, pool: route.record.pool, eventIndex: route.eventIndex },
          account.address, { name: 'Flurbo automatic source reading',
            description: `${event.question}\n\nFlurbo reader answer: ${outcomeLabel[observation.outcome]}.\nPublished rule: ${event.source.ruleURI}\nCapture evidence: ${observation.evidenceURI}`,
            sourceURL: observation.evidenceURI });
        return proxyRequest('submitEvidence', [BigInt(q), doc.uri]);
      });
      if (result === 'submitted' || result === 'pending') return;
    }
    const court = await klerosCourtSnapshot(source, proxy, state.disputeId);
    const phase = await klerosCourtPhase(source, court.court);
    summary.period = court.periodLabel;
    const action = courtAction({ now: state.sourceNow, court, phase, voteWaitSeconds });
    summary.waiting = action.kind === 'wait' ? action.reason : null;
    if (action.kind === 'wait') return;
    const courtRequest = (functionName, args = []) => ({ address: court.court, abi: courtAbi, functionName, args });
    const disputeId = BigInt(court.disputeId);
    if (action.kind === 'passPhase')
      await send(`court:passPhase:${phase.lastPhaseChange}`, () => courtRequest('passPhase'));
    else if (action.kind === 'executeDelayedSetStakes')
      await send(`${q}:${state.disputeId}:delayed:${phase.nextDelayed}`,
        () => courtRequest('executeDelayedSetStakes', [BigInt(action.iterations)]));
    else if (action.kind === 'drawJurors')
      await send(`${q}:${state.disputeId}:draw-${court.rounds}-${court.drawn}`,
        () => courtRequest('drawJurors', [disputeId, BigInt(action.iterations)]));
    else await send(`${q}:${state.disputeId}:${action.kind}-${court.rounds}-${court.period}`,
      () => courtRequest(action.kind, [disputeId]));
  }

  async function tick() {
    if (running) return;
    running = true; cycles++;
    try {
      if (await source.getChainId() !== 11155111) throw Error('Hybrid court keeper chain mismatch');
      for (const route of routes) {
        try { await step(route); errors.delete(route.id); }
        catch (error) {
          const message = safeError(error);
          if (errors.get(route.id) !== message) console.error(`Hybrid court ${route.id}: ${message}`);
          errors.set(route.id, message);
        }
      }
      lastError = [...errors].map(([id, message]) => `${id}: ${message}`).join('; ') || null;
    } catch (error) {
      lastError = safeError(error);
      console.error(lastError);
    } finally { running = false; lastFinishedAt = new Date().toISOString(); }
  }

  return { tick,
    start() { if (!timer) { timer = setInterval(() => { void tick(); }, intervalMs); timer.unref(); void tick(); } },
    stop() { if (timer) clearInterval(timer); timer = null; },
    status() { return { enabled: Boolean(timer), running, cycles, routes: routes.length,
      keeper: account.address, lastError, lastFinishedAt, cases: Object.fromEntries(results) }; },
  };
}
