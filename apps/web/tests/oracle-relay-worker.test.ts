import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, keccak256, toFunctionSelector, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { oracleRelayWorker } from '../server/oracle-relay-worker.mjs';
import { wideResolverAbi } from '../server/reality-relay.mjs';

const key = `0x${'1'.repeat(64)}`;
const relay = privateKeyToAccount(key).address;
const pool = `0x${'2'.repeat(40)}`;
const resolver = `0x${'3'.repeat(40)}`;
const reportSelector = toFunctionSelector('reportFinal(uint8,uint8,bytes32,string)');
const deliverSelector = toFunctionSelector('deliver()');
const voidSelector = toFunctionSelector('finalizeMissing(uint8)');

test('relay persists final evidence before reporting and delivers only after both cases finish', async () => {
  const routes = [0, 1].map(eventIndex => ({ id: `event-${eventIndex}`, pool, resolver, relay,
    reality: `0x${'4'.repeat(40)}`, questionId: `0x${(eventIndex + 1).toString(16).repeat(64)}`,
    eventIndex, publication: { events: [{ observationEndsAt: 100 }, { observationEndsAt: 100 }],
      reportPeriod: 1000 } }));
  const phases = [0, 0], keys = new Map<string, string>();
  let resolved = false;
  const sent: string[] = [];
  const command = async (op: string, keyName: string, value?: string) => {
    if (op === 'SET') {
      if (keys.has(keyName) && value === 'preparing') return null;
      keys.set(keyName, value || ''); return 'OK';
    }
    if (op === 'DEL') { keys.delete(keyName); return 1; }
    return null;
  };
  const market = { getChainId: async () => 10143, getBlock: async () => ({ timestamp: 200n }),
    readContract: async ({ functionName, args }: any) => functionName === 'caseState' ? { phase: phases[args[0]] }
      : functionName === 'resolved' ? resolved : functionName === 'eventCount' ? 2 : null,
    waitForTransactionReceipt: async () => ({ status: 'success' }) };
  const source = { getChainId: async () => 11155111,
    readContract: async () => true };
  const evidence = { putRelay: async (body: string) => {
    sent.push('evidence'); return `https://example.org/api/oracle/evidence/${keccak256(toHex(body))}`;
  } };
  const walletClient = { sendTransaction: async ({ data }: any) => {
    const selector = data.slice(0, 10);
    if (selector === reportSelector) {
      const eventIndex = Number(data.slice(10 + 63, 10 + 64));
      assert.equal(sent.at(-1), 'evidence'); phases[eventIndex] = 1; sent.push('report');
    } else if (selector === deliverSelector) {
      assert.deepEqual(phases, [1, 1]); resolved = true; sent.push('deliver');
    } else throw Error('Unexpected worker transaction');
    return `0x${'a'.repeat(64)}`;
  } };
  const worker = oracleRelayWorker({ routes, source, market, command, evidence,
    rpcUrl: 'https://example.org', privateKey: key, walletClient,
    prepareFinal: async (route: any) => {
      const evidenceJson = JSON.stringify({ schema: 'flurbo.reality-evidence.v2', eventIndex: route.eventIndex });
      const evidenceURI = `https://example.org/api/oracle/evidence/${keccak256(toHex(evidenceJson))}`;
      const data = encodeFunctionData({ abi: wideResolverAbi, functionName: 'reportFinal',
        args: [route.eventIndex, 2, keccak256(toHex(evidenceJson)), evidenceURI] });
      return { evidenceJson, evidenceURI, transaction: { to: resolver, data } };
    } });
  await worker.tick();
  assert.equal(resolved, true);
  assert.deepEqual(sent, ['evidence', 'report', 'evidence', 'report', 'deliver']);
  assert.equal(worker.status().lastError, null);
});

test('missed report deadline voids only the pending event and then delivers', async () => {
  const phases = [0, 1], sent: string[] = [];
  const routes = [0, 1].map(eventIndex => ({ id: `event-${eventIndex}`, pool, resolver, relay,
    eventIndex, publication: { events: [{ observationEndsAt: 100 }, { observationEndsAt: 100 }],
      reportPeriod: 1000 } }));
  const worker = oracleRelayWorker({ routes, privateKey: key, rpcUrl: 'https://example.org',
    command: async () => 'OK', evidence: { putRelay: async () => { throw Error('No final source'); } },
    source: { getChainId: async () => 11155111 },
    market: { getChainId: async () => 10143, getBlock: async () => ({ timestamp: 1500n }),
      readContract: async ({ functionName, args }: any) => functionName === 'caseState'
        ? { phase: phases[args[0]] } : functionName === 'resolved' ? false : 2,
      waitForTransactionReceipt: async () => ({ status: 'success' }) },
    walletClient: { sendTransaction: async ({ data }: any) => {
      if (data.startsWith(voidSelector)) { phases[0] = 1; sent.push('void'); }
      else if (data.startsWith(deliverSelector)) sent.push('deliver');
      else throw Error('Unexpected transaction');
      return `0x${'a'.repeat(64)}`;
    } } });
  await worker.tick();
  assert.deepEqual(sent, ['void', 'deliver']);
});
