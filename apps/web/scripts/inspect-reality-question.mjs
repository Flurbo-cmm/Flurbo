import { createPublicClient, decodeEventLog, getAddress, http, parseAbi, parseAbiItem } from 'viem';
import { SEPOLIA_KLEROS, SEPOLIA_REALITY } from '../server/oracle-integration.mjs';

const event = parseAbiItem('event LogNewQuestion(bytes32 indexed question_id,address indexed user,uint256 template_id,string question,bytes32 indexed content_hash,address arbitrator,uint32 timeout,uint32 opening_ts,uint256 nonce,uint256 created)');
const getters = parseAbi(['function getMinBond(bytes32) view returns (uint256)',
  'function getTimeout(bytes32) view returns (uint32)']);
const [txHash, expectedCreator, expectedTitle, expectedOpening] = process.argv.slice(2);
if (!/^0x[0-9a-fA-F]{64}$/.test(txHash || '') || !/^0x[0-9a-fA-F]{40}$/.test(expectedCreator || '')
  || !expectedTitle || !/^\d+$/.test(expectedOpening || ''))
  throw Error('Usage: node inspect-reality-question.mjs <tx-hash> <creator-address> <exact-title> <opening-unix-seconds>');
const rpc = process.env.FLURBO_SEPOLIA_RPC_URL;
if (!rpc?.startsWith('https://')) throw Error('Set FLURBO_SEPOLIA_RPC_URL to a Sepolia HTTPS RPC');
const client = createPublicClient({ transport: http(rpc) });
if (await client.getChainId() !== 11155111) throw Error('Sepolia RPC required');
const receipt = await client.getTransactionReceipt({ hash: txHash });
if (receipt.status !== 'success') throw Error('Question transaction failed');
let question = null;
for (const log of receipt.logs) {
  if (log.address.toLowerCase() !== SEPOLIA_REALITY.toLowerCase()) continue;
  try {
    const decoded = decodeEventLog({ abi: [event], data: log.data, topics: log.topics });
    if (decoded.eventName === 'LogNewQuestion' && decoded.args.template_id === 0n
      && decoded.args.user.toLowerCase() === expectedCreator.toLowerCase()
      && decoded.args.arbitrator.toLowerCase() === SEPOLIA_KLEROS.toLowerCase()
      && decoded.args.question === `${expectedTitle}␟flurbo-poc␟en`
      && Number(decoded.args.opening_ts) === Number(expectedOpening)) question = decoded.args;
  } catch {}
}
if (!question) throw Error('Pinned Reality question, title, creator or opening time mismatch');
const [minBond, timeout] = await Promise.all([
  client.readContract({ address: getAddress(SEPOLIA_REALITY), abi: getters,
    functionName: 'getMinBond', args: [question.question_id] }),
  client.readContract({ address: getAddress(SEPOLIA_REALITY), abi: getters,
    functionName: 'getTimeout', args: [question.question_id] }),
]);
if (minBond < 1n || timeout < 3600) throw Error('Question minimum bond or timeout too small');
process.stdout.write(JSON.stringify({ kind: 'reality-sepolia', chainId: 11155111,
  reality: SEPOLIA_REALITY, arbitrator: SEPOLIA_KLEROS,
  questionId: question.question_id, contentHash: question.content_hash,
  questionTxHash: txHash, questionText: question.question,
  minTimeout: timeout, minBond: minBond.toString() }, null, 2) + '\n');
