import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbiItem, parseAbiParameters, toHex } from 'viem';
import { createHybridRealityPilot } from '../scripts/create-hybrid-reality-pilot.mjs';
import { completeHybridRealityDraft } from '../scripts/complete-hybrid-reality-draft.mjs';
import { SEPOLIA_KLEROS_LIQUID, SEPOLIA_REALITY } from '../server/oracle-integration.mjs';

export const creator = '0xF1feA08EbBa92eD342Acc5639dB312C3694Bc391';
export const proposer = '0xa45c95f673580132F2E6f75372808162Ea069d49';
export const relay = '0x51dd3f8eD77e49e8099b79d455F16b0bF8e120E1';
export const origin = 'https://flurbopm.singu.online';
export const proxyCode = '0x6080';
export const txHashes = [`0x${'5'.repeat(64)}`, `0x${'6'.repeat(64)}`];
const newQuestion = parseAbiItem('event LogNewQuestion(bytes32 indexed question_id,address indexed user,uint256 template_id,string question,bytes32 indexed content_hash,address arbitrator,uint32 timeout,uint32 opening_ts,uint256 nonce,uint256 created)');

export const createdTemplate = () => createHybridRealityPilot({ creator, proposer, relay,
  closesAt: Math.floor(Date.now() / 1000) + 3 * 3600, origin });

export function receiptFor(template: any, index: number, override: Record<string, unknown> = {}) {
  const item = template.questions[index];
  const questionId = `0x${String(index + 1).repeat(64)}`;
  const text = (override.questionText as string) ?? item.questionText;
  const topics = encodeEventTopics({ abi: [newQuestion], eventName: 'LogNewQuestion',
    args: { question_id: questionId, user: creator, content_hash: keccak256(toHex(text)) } });
  const data = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'string' }, { type: 'address' }, { type: 'uint32' },
      { type: 'uint32' }, { type: 'uint256' }, { type: 'uint256' }],
    [0n, text, (override.arbitrator as string) ?? template.draft.events[index].source.arbitrator,
      item.timeout, item.opening, 0n, 1n]);
  return { status: 'success', logs: [{ address: SEPOLIA_REALITY, topics, data }] };
}

export function fakeSepolia(template: any, override: Record<string, unknown> = {}) {
  const receipts = new Map<string, any>();
  template.questions.forEach((_: any, index: number) =>
    receipts.set(txHashes[index], receiptFor(template, index, index === 0 ? override : {})));
  return { getChainId: async () => 11155111,
    getTransactionReceipt: async ({ hash }: { hash: string }) => receipts.get(hash),
    getBytecode: async () => (override.proxyCode as string) ?? proxyCode,
    readContract: async ({ functionName }: { functionName: string }) => ({
      getMinBond: BigInt(template.questions[0].minBondWei), realitio: SEPOLIA_REALITY,
      arbitrator: SEPOLIA_KLEROS_LIQUID,
      arbitratorExtraData: (override.extraData as string) ?? encodeAbiParameters(parseAbiParameters('uint256,uint256'), [3n, 1n]),
    } as Record<string, unknown>)[functionName] ?? 3600 };
}

export async function completedDraft() {
  const template = createdTemplate();
  const draft = await completeHybridRealityDraft(template, txHashes, fakeSepolia(template));
  return { template, draft };
}
