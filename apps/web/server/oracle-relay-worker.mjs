import { createWalletClient, defineChain, encodeFunctionData, getAddress, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { prepareRealityRelay, wideResolverAbi } from './reality-relay.mjs';

const monadTestnet = defineChain({ id: 10143, name: 'Monad Testnet', nativeCurrency: {
  name: 'MON', symbol: 'MON', decimals: 18 }, rpcUrls: { default: { http: ['https://testnet-rpc.monad.xyz'] } } });
const deliveryAbi = parseAbi(['function finalizeMissing(uint8)', 'function deliver()']);
const lockKey = (pool, step) => `flurbo:oracle-relay:v1:${pool.toLowerCase()}:${step}`;

export function oracleRelayWorker({ routes, source, market, command, evidence, rpcUrl, privateKey,
  intervalMs = 120_000, walletClient = null, prepareFinal = prepareRealityRelay }) {
  if (!Array.isArray(routes) || !routes.length || typeof command !== 'function' || !evidence
    || !/^0x[0-9a-fA-F]{64}$/.test(privateKey || '') || !rpcUrl?.startsWith('https://'))
    throw Error('Oracle relay configuration incomplete');
  const account = privateKeyToAccount(privateKey);
  if (routes.some(route => route.relay.toLowerCase() !== account.address.toLowerCase()))
    throw Error('Oracle relay signer does not match every route');
  const wallet = walletClient || createWalletClient({ account, chain: monadTestnet,
    transport: http(rpcUrl, { timeout: 20_000 }) });
  let timer = null, running = false, cycles = 0, lastFinishedAt = null;
  let lastError = null;
  async function send(pool, step, contract, data) {
    const lock = lockKey(pool, step);
    if (await command('SET', lock, 'preparing', 'EX', 300, 'NX') !== 'OK') return false;
    try {
      const hash = await wallet.sendTransaction({ account, chain: monadTestnet,
        to: getAddress(contract), data });
      await command('SET', lock, hash, 'EX', 300);
      let receipt;
      try { receipt = await market.waitForTransactionReceipt({ hash, timeout: 90_000 }); }
      catch { return false; }
      if (receipt.status !== 'success') throw Error('Oracle relay transaction reverted');
      return true;
    } catch (error) {
      await command('DEL', lock);
      throw error;
    }
  }
  async function tick() {
    if (running) return;
    running = true;
    cycles++;
    lastError = null;
    try {
      if (await market.getChainId() !== 10143 || await source.getChainId() !== 11155111)
        throw Error('Oracle relay RPC chain mismatch');
      const now = Number((await market.getBlock()).timestamp);
      const pools = new Map();
      for (const route of routes) {
        const key = route.pool.toLowerCase();
        if (!pools.has(key)) pools.set(key, route);
        try {
          const state = await market.readContract({ address: getAddress(route.resolver),
            abi: wideResolverAbi, functionName: 'caseState', args: [route.eventIndex] });
          if (Number(state.phase ?? state[0]) !== 0) continue;
          const deadline = route.publication.events[route.eventIndex].observationEndsAt + route.publication.reportPeriod;
          if (now >= deadline) {
            await send(route.pool, `void-${route.eventIndex}`, route.resolver,
              encodeFunctionData({ abi: deliveryAbi, functionName: 'finalizeMissing', args: [route.eventIndex] }));
            continue;
          }
          if (now < route.publication.events[route.eventIndex].observationEndsAt) continue;
          const finalized = await source.readContract({ address: getAddress(route.reality),
            abi: parseAbi(['function isFinalized(bytes32) view returns (bool)']),
            functionName: 'isFinalized', args: [route.questionId] });
          if (!finalized) continue;
          const prepared = await prepareFinal(route, source, market);
          const uri = await evidence.putRelay(prepared.evidenceJson);
          if (uri !== prepared.evidenceURI) throw Error('Oracle relay evidence URI mismatch');
          await send(route.pool, `report-${route.eventIndex}`, route.resolver, prepared.transaction.data);
        } catch {
          lastError = `Oracle route ${route.id} needs attention`;
          console.error(lastError);
        }
      }
      for (const route of pools.values()) {
        const resolved = await market.readContract({ address: getAddress(route.pool), abi: parseAbi([
          'function resolved() view returns (bool)']), functionName: 'resolved' });
        if (resolved) continue;
        const count = await market.readContract({ address: getAddress(route.resolver),
          abi: wideResolverAbi, functionName: 'eventCount' });
        let ready = true;
        for (let i = 0; i < Number(count); i++) {
          const state = await market.readContract({ address: getAddress(route.resolver),
            abi: wideResolverAbi, functionName: 'caseState', args: [i] });
          if (Number(state.phase ?? state[0]) === 0) { ready = false; break; }
        }
        if (ready) await send(route.pool, 'deliver', route.resolver,
          encodeFunctionData({ abi: deliveryAbi, functionName: 'deliver' }));
      }
    } catch (error) {
      lastError = error instanceof Error && /^Oracle relay /.test(error.message)
        ? error.message : 'Oracle relay cycle failed';
      console.error(lastError);
    } finally { running = false; lastFinishedAt = new Date().toISOString(); }
  }
  return {
    tick,
    start() { if (!timer) { timer = setInterval(() => { void tick(); }, intervalMs);
      timer.unref(); void tick(); } },
    stop() { if (timer) clearInterval(timer); timer = null; },
    status() { return { enabled: Boolean(timer), running, cycles, lastFinishedAt, lastError,
      signer: account.address, routes: routes.length }; },
  };
}


