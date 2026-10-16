import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPublicClient, http } from 'viem';
import { inspectRealityQuestion } from './inspect-reality-question.mjs';
import { prepareHybridPilot } from './prepare-hybrid-pilot.mjs';

export async function completeHybridRealityDraft(template, txHashes, client) {
  if (template?.schema !== 'flurbo.hybrid-reality-template.v1'
    || !Array.isArray(txHashes) || txHashes.length !== template.questions.length)
    throw Error('Provide one question transaction per template question');
  const draft = structuredClone(template.draft);
  for (const [index, item] of template.questions.entries()) {
    const found = await inspectRealityQuestion(client, { txHash: txHashes[index],
      creator: draft.creator, questionText: item.questionText, opening: item.opening,
      minTimeout: item.timeout, arbitrator: draft.events[index].source.arbitrator });
    if (found.minBond !== item.minBondWei) throw Error('Question minimum bond differs from the template');
    const { questionId, contentHash, questionTxHash } = found;
    Object.assign(draft.events[index].source, { questionId, contentHash, questionTxHash });
  }
  prepareHybridPilot(draft);
  return draft;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [templatePath, ...rest] = process.argv.slice(2);
  const output = rest.pop();
  const rpc = process.env.FLURBO_SEPOLIA_RPC_URL;
  if (!templatePath || !output || !rest.length || !rpc?.startsWith('https://'))
    throw Error('Usage: node complete-hybrid-reality-draft.mjs TEMPLATE.json TX0 TX1 OUTPUT_DRAFT.json  (or: TEMPLATE.json TXS.json OUTPUT_DRAFT.json)');
  const template = JSON.parse(await readFile(templatePath, 'utf8'));
  const txHashes = rest.length === 1 && rest[0].endsWith('.json')
    ? JSON.parse(await readFile(rest[0], 'utf8'))
    : rest;
  const draft = await completeHybridRealityDraft(template, txHashes, createPublicClient({ transport: http(rpc) }));
  await writeFile(output, JSON.stringify(draft, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: 'draft_completed', events: draft.events.length, output }));
}
