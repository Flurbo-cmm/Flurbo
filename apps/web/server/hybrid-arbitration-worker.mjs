import { createWalletClient, defineChain, getAddress, http, keccak256, parseAbi, parseAbiItem, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { redactUrls } from './redact.mjs';

const monad = defineChain({ id: 10143, name: 'Monad Testnet', nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://testnet-rpc.monad.xyz'] } } });
const sepolia = defineChain({ id: 11155111, name: 'Sepolia', nativeCurrency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://ethereum-sepolia-rpc.publicnode.com'] } } });
const address = value => /^0x[0-9a-fA-F]{40}$/.test(value || '');
const hash32 = value => /^0x[0-9a-fA-F]{64}$/.test(value || '');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const resolverAbi = parseAbi([
  'function protocolVersion() pure returns (uint8)',
  'function rulesHash() view returns (bytes32)',
  'function pool() view returns (address)',
  'function relay() view returns (address)',
  'function eventHashes(uint256) view returns (bytes32)',
  'function routes(uint256) view returns (uint8)',
  'function caseState(uint8) view returns ((uint8 phase,uint8 proposal,uint8 counter,uint8 result,address challenger,bytes32 evidenceHash,bytes32 counterEvidenceHash,bytes32 requestId,bytes32 sourceCaseId,uint64 challengeUntil,uint64 arbitrationUntil))',
  'function linkSourceCase(uint8,bytes32)',
  'function reportRuling(uint8,bytes32,uint8,bytes32,string)',
]);
const caseAbi = parseAbi([
  'function manager() view returns (address)',
  'function caseState(bytes32) view returns ((uint256 disputeId,bytes32 requestId,bytes32 questionHash,uint8 ruling,bool opened,bool ruled))',
  'function sourceCaseId(bytes32) view returns (bytes32)',
  'function arbitrationCost() view returns (uint256)',
  'function openCase(bytes32,bytes32,string) payable returns (uint256)',
]);
const proposedEvent = parseAbiItem('event Proposed(uint8 indexed eventIndex,uint8 outcome,bytes32 evidenceHash,string evidenceURI,uint64 challengeUntil)');
const challengedEvent = parseAbiItem('event Challenged(uint8 indexed eventIndex,address indexed challenger,bytes32 indexed requestId,uint8 counter,bytes32 evidenceHash,string evidenceURI,uint64 arbitrationUntil)');

export function hybridArbitrationCatalog(value) {
  if (value?.schema !== 'flurbo.hybrid-arbitration-catalog.v1' || !Array.isArray(value.routes)
    || value.routes.length > 512) throw Error('Invalid hybrid arbitration catalog');
  const ids = new Set(), events = new Set();
  for (const route of value.routes) {
    if (!route || typeof route.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(route.id)
      || ![route.pool, route.resolver, route.adapter, route.manager, route.relay].every(address)
      || ![route.rulesHash, route.eventHash].every(hash32)
      || !Number.isSafeInteger(route.eventIndex) || route.eventIndex < 0 || route.eventIndex > 31
      || !Number.isSafeInteger(route.deploymentBlock) || route.deploymentBlock < 1
      || typeof route.question !== 'string' || route.question.length < 8 || route.question.length > 1000
      || ids.has(route.id) || events.has(`${route.resolver.toLowerCase()}:${route.eventIndex}`))
      throw Error('Invalid hybrid arbitration route');
    ids.add(route.id);
    events.add(`${route.resolver.toLowerCase()}:${route.eventIndex}`);
  }
  return value;
}

export async function hybridDisputeSnapshot(route, market, source) {
  const resolver = getAddress(route.resolver), adapter = getAddress(route.adapter);
  const readMarket = (functionName, args = []) => market.readContract({ address: resolver, abi: resolverAbi, functionName, args });
  const [chainId, sourceChainId, version, rulesHash, pool, relay, eventHash, kind, state] = await Promise.all([
    market.getChainId(), source.getChainId(), readMarket('protocolVersion'), readMarket('rulesHash'),
    readMarket('pool'), readMarket('relay'), readMarket('eventHashes', [route.eventIndex]),
    readMarket('routes', [route.eventIndex]), readMarket('caseState', [route.eventIndex]),
  ]);
  if (chainId !== 10143 || sourceChainId !== 11155111 || Number(version) !== 4
    || !same(rulesHash, route.rulesHash) || !same(pool, route.pool)
    || !same(relay, route.relay) || !same(eventHash, route.eventHash) || Number(kind) !== 0)
    throw Error('Hybrid arbitration route differs from deployed contracts');
  if (Number(state.phase) !== 2) return { action: 'wait', state };
  const requestId = state.requestId;
  if (!hash32(requestId) || /^0x0{64}$/i.test(requestId)) throw Error('Hybrid dispute request missing');
  const sourceBlock = await source.getBlock({ blockTag: 'finalized' });
  if (!sourceBlock?.hash || sourceBlock.number === undefined) throw Error('Finalized Sepolia block unavailable');
  const [manager, sourceCase] = await Promise.all([
    source.readContract({ address: adapter, abi: caseAbi, functionName: 'manager', blockNumber: sourceBlock.number }),
    source.readContract({ address: adapter, abi: caseAbi, functionName: 'caseState', args: [requestId], blockNumber: sourceBlock.number }),
  ]);
  if (!same(manager, route.manager)) throw Error('Hybrid case manager differs from catalog');
  if (!sourceCase.opened) return { action: 'open', state, requestId, sourceBlock };
  if (!same(sourceCase.requestId, requestId) || !same(sourceCase.questionHash, route.eventHash))
    throw Error('Kleros source case differs from Monad question');
  const sourceCaseId = await source.readContract({ address: adapter, abi: caseAbi,
    functionName: 'sourceCaseId', args: [requestId], blockNumber: sourceBlock.number });
  if (!hash32(sourceCaseId) || /^0x0{64}$/i.test(sourceCaseId)) throw Error('Invalid source case ID');
  if (/^0x0{64}$/i.test(state.sourceCaseId))
    return { action: 'link', state, requestId, sourceCase, sourceCaseId, sourceBlock };
  if (!same(state.sourceCaseId, sourceCaseId)) throw Error('Linked source case differs from Kleros');
  if (!sourceCase.ruled) return { action: 'wait', state, requestId, sourceCase, sourceCaseId };
  if (![1, 2, 3].includes(Number(sourceCase.ruling))) throw Error('Invalid Kleros ruling');
  return { action: 'report', state, requestId, sourceCase, sourceCaseId, sourceBlock };
}

async function caseEvidence(route, snapshot, market, evidence) {
  const head = await market.getBlockNumber();
  if (head < BigInt(route.deploymentBlock) + 12n) return null;
  const toBlock = head - 12n, base = { address: getAddress(route.resolver),
    args: { eventIndex: route.eventIndex }, fromBlock: BigInt(route.deploymentBlock), toBlock };
  const [proposals, challenges] = await Promise.all([
    market.getLogs({ ...base, event: proposedEvent }),
    market.getLogs({ ...base, event: challengedEvent }),
  ]);
  const proposal = proposals.findLast(log => same(log.args.evidenceHash, snapshot.state.evidenceHash));
  const challenge = challenges.findLast(log => same(log.args.requestId, snapshot.requestId));
  if (!proposal || !challenge || Number(proposal.args.outcome) !== Number(snapshot.state.proposal)
    || Number(challenge.args.counter) !== Number(snapshot.state.counter)
    || !same(challenge.args.evidenceHash, snapshot.state.counterEvidenceHash)
    || !same(challenge.args.challenger, snapshot.state.challenger)
    || Number(challenge.args.arbitrationUntil) !== Number(snapshot.state.arbitrationUntil)) return null;
  return evidence.putHybridCase({ pool: route.pool, resolver: route.resolver, eventIndex: route.eventIndex,
    eventHash: route.eventHash, requestId: snapshot.requestId, question: route.question,
    proposal: Number(snapshot.state.proposal), counter: Number(snapshot.state.counter),
    proposalEvidenceURI: proposal.args.evidenceURI, counterEvidenceURI: challenge.args.evidenceURI });
}

const publicErrors = new Set(['Finalized Sepolia block unavailable', 'Hybrid arbitration route differs from deployed contracts',
  'Hybrid arbitration transaction hash invalid', 'Hybrid arbitration transaction reverted', 'Hybrid case manager differs from catalog',
  'Hybrid dispute request missing', 'Invalid Kleros ruling', 'Invalid source case ID', 'Kleros source case differs from Monad question',
  'Linked source case differs from Kleros', 'Sepolia case manager needs arbitration fee and gas', 'Invalid hybrid case evidence',
  'Hybrid case evidence too large', 'Hybrid case evidence persistence failed', 'Invalid hybrid ruling evidence',
  'Hybrid ruling evidence persistence failed']);
const safeError = error => publicErrors.has(error?.message) ? error.message
  : 'Hybrid arbitration source or transaction request failed';

const journalKey = (route, action, requestId) =>
  `flurbo:hybrid-arbitration:v1:${route.resolver.toLowerCase()}:${route.eventIndex}:${requestId.toLowerCase()}:${action}`;

export function hybridArbitrationWorker({ routes, market, source, command, evidence, marketRpcUrl, sourceRpcUrl,
  managerPrivateKey, relayPrivateKey, managerWallet = null, relayWallet = null,
  relaySend = task => task(), intervalMs = 120_000 }) {
  hybridArbitrationCatalog({ schema: 'flurbo.hybrid-arbitration-catalog.v1', routes });
  if (!routes.length || typeof command !== 'function' || !evidence?.putHybridCase || !evidence?.putHybridRuling
    || !/^0x[0-9a-fA-F]{64}$/.test(managerPrivateKey || '')
    || !/^0x[0-9a-fA-F]{64}$/.test(relayPrivateKey || '')
    || !sourceRpcUrl?.startsWith('https://') || !marketRpcUrl?.startsWith('https://'))
    throw Error('Hybrid arbitration worker configuration incomplete');
  const manager = privateKeyToAccount(managerPrivateKey), relay = privateKeyToAccount(relayPrivateKey);
  if (same(manager.address, relay.address) || routes.some(route => !same(route.manager, manager.address) || !same(route.relay, relay.address)))
    throw Error('Hybrid arbitration wallet roles differ from the catalog');
  const sourceWallet = managerWallet || createWalletClient({ account: manager, chain: sepolia,
    transport: http(sourceRpcUrl, { timeout: 20_000 }) });
  const marketWallet = relayWallet || createWalletClient({ account: relay, chain: monad,
    transport: http(marketRpcUrl, { timeout: 20_000 }) });
  let timer = null, running = false, cycles = 0, lastError = null, lastFinishedAt = null;

  async function send(route, action, requestId, client, wallet, request) {
    const key = journalKey(route, action, requestId), saved = await command('GET', key);
    if (saved === 'preparing') return 'pending';
    if (saved) {
      const receipt = await client.getTransactionReceipt({ hash: saved }).catch(() => null);
      if (!receipt) return 'pending';
      if (receipt.status !== 'success') {
        await command('DEL', key);
        throw Error('Hybrid arbitration transaction reverted');
      }
      return 'confirmed';
    }
    await client.simulateContract(request);
    if (await command('SET', key, 'preparing', 'EX', 1800, 'NX') !== 'OK') return 'pending';
    const hash = same(wallet.address, relay.address)
      ? await relaySend(() => wallet.writeContract(request)) : await wallet.writeContract(request);
    if (!hash32(hash)) throw Error('Hybrid arbitration transaction hash invalid');
    await command('SET', key, hash, 'EX', 86400);
    return 'submitted';
  }

  async function tick() {
    if (running) return;
    running = true; cycles++;
    try {
      for (const route of routes) {
        const snapshot = await hybridDisputeSnapshot(route, market, source);
        if (snapshot.action === 'wait') continue;
        if (snapshot.action === 'open') {
          const retained = await caseEvidence(route, snapshot, market, evidence);
          if (!retained) continue;
          const fee = await source.readContract({ address: getAddress(route.adapter), abi: caseAbi, functionName: 'arbitrationCost' });
          if (fee <= 0n || await source.getBalance({ address: manager.address }) <= fee)
            throw Error('Sepolia case manager needs arbitration fee and gas');
          await send(route, 'open', snapshot.requestId, source, sourceWallet, { account: manager, chain: sepolia,
            address: getAddress(route.adapter), abi: caseAbi, functionName: 'openCase',
            args: [snapshot.requestId, route.eventHash, retained.uri], value: fee });
          return;
        }
        if (snapshot.action === 'link') {
          await send(route, 'link', snapshot.requestId, market, marketWallet, { account: relay, chain: monad,
            address: getAddress(route.resolver), abi: resolverAbi, functionName: 'linkSourceCase',
            args: [route.eventIndex, snapshot.sourceCaseId] });
          return;
        }
        const retained = await evidence.putHybridRuling({ pool: route.pool, resolver: route.resolver,
          eventIndex: route.eventIndex, eventHash: route.eventHash, requestId: snapshot.requestId,
          sourceCaseId: snapshot.sourceCaseId, adapter: route.adapter,
          disputeId: snapshot.sourceCase.disputeId.toString(), ruling: Number(snapshot.sourceCase.ruling),
          sourceBlockHash: snapshot.sourceBlock.hash });
        await send(route, 'report', snapshot.requestId, market, marketWallet, { account: relay, chain: monad,
          address: getAddress(route.resolver), abi: resolverAbi, functionName: 'reportRuling',
          args: [route.eventIndex, snapshot.sourceCaseId, Number(snapshot.sourceCase.ruling),
            keccak256(toHex(await evidence.get(retained.hash))), retained.uri] });
        return;
      }
      lastError = null;
    } catch (error) {
      lastError = safeError(error);
      console.error(`Hybrid arbitration cycle failed: ${redactUrls(error instanceof Error ? error.message : String(error))}`);
    } finally { running = false; lastFinishedAt = new Date().toISOString(); }
  }

  return { tick,
    start() { if (!timer) { timer = setInterval(() => { void tick(); }, intervalMs); timer.unref(); void tick(); } },
    stop() { if (timer) clearInterval(timer); timer = null; },
    status() { return { enabled: Boolean(timer), running, cycles, routes: routes.length, lastError, lastFinishedAt,
      manager: manager.address, relay: relay.address }; },
  };
}
