// Writes the JSON Schemas in protocol/schemas. Run: node protocol/tools/generate-schemas.mjs [--check]
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const dir = new URL('../schemas/', import.meta.url), check = process.argv.includes('--check');
const atoms = { type: 'string', pattern: '^(0|[1-9][0-9]{0,77})$' }, addr = { type: 'string', pattern: '^0x[0-9a-f]{40}$' }, hash = { type: 'string', pattern: '^0x[0-9a-f]{64}$' };
const claim = { type: 'object', additionalProperties: false, required: ['scope', 'mask'], properties: { scope: { type: 'integer', minimum: 1, maximum: 15 }, mask: { type: 'string', pattern: '^[1-9][0-9]{0,2}$' } } };
const schemas = {
  'deployment.v1.json': { title: 'flurbo.agent-deployment.v1', type: 'object',
    required: ['schema', 'interface', 'namespace', 'chainId', 'pool', 'resolver', 'collateral', 'codeHashes', 'rulesHash', 'closesAt', 'eventCount', 'limits'],
    properties: { schema: { const: 'flurbo.agent-deployment.v1' }, interface: { const: 'flurbo.pilot-pool.v1' }, namespace: { type: 'string', pattern: '^(pilot|practice-[0-9a-f]{40})$' },
      chainId: { const: 10143 }, pool: addr, resolver: addr,
      collateral: { type: 'object', required: ['address', 'decimals'], properties: { address: { const: '0xa9012a055bd4e0edff8ce09f960291c09d5322dc' }, decimals: { const: 6 } } },
      codeHashes: { type: 'object', required: ['pool', 'resolver'], properties: { pool: hash, resolver: hash } }, rulesHash: hash, closesAt: { type: 'integer' }, eventCount: { enum: [2, 3, 4] },
      limits: { type: 'object', required: ['maxQuantityAtoms', 'maxLimitAtoms', 'slippageBps', 'maxDeadlineSeconds'],
        properties: { maxQuantityAtoms: { const: '100000000' }, maxLimitAtoms: { const: '100000000' }, slippageBps: { const: [10, 50, 100] }, maxDeadlineSeconds: { const: 300 } } } } },
  'market.v1.json': { title: 'flurbo.agent-market.v1', type: 'object',
    required: ['schema', 'namespace', 'deployment', 'title', 'closesAt', 'open', 'resolved', 'resolution', 'snapshot', 'events', 'oneShareBuyAtoms'],
    properties: { schema: { const: 'flurbo.agent-market.v1' }, namespace: { type: 'string' }, deployment: { $ref: 'deployment.v1.json' }, title: { type: 'string' },
      closesAt: { type: 'integer' }, open: { type: 'boolean' }, resolved: { type: 'boolean' },
      resolution: { oneOf: [{ type: 'null' }, { type: 'object', required: ['yesMask', 'voidMask'], properties: { yesMask: { type: 'integer' }, voidMask: { type: 'integer' } } }] },
      snapshot: { type: 'object', required: ['blockNumber', 'blockHash', 'timestamp'], properties: { blockNumber: atoms, blockHash: hash, timestamp: { type: 'integer' } } },
      events: { type: 'array', items: { type: 'object', required: ['index', 'id', 'question', 'yesRule', 'noRule', 'observationEndsAt', 'source'],
        properties: { index: { type: 'integer' }, id: { type: 'string' }, question: { type: 'string' }, yesRule: { type: 'string' }, noRule: { type: 'string' },
          observationStartsAt: { type: ['integer', 'null'] }, observationEndsAt: { type: 'integer' },
          source: { type: ['object', 'null'], properties: { publisher: { type: ['string', 'null'] }, referenceUrl: { type: ['string', 'null'] } } },
          settlement: { type: ['object', 'null'], description: 'The exact sources settlement reads for this question. Null for practice questions or when no machine-checked source is committed.',
            properties: { method: { type: 'string' }, request: { enum: ['GET', 'JSON-RPC'] }, urls: { type: 'array', items: { type: 'string' } } } } } } },
      oneShareBuyAtoms: { type: 'array', description: 'One-share buy costs at the snapshot. A finite purchase cost, not a probability. Null when closed.',
        items: { type: 'object', properties: { event: { type: 'integer' }, yes: { oneOf: [atoms, { type: 'null' }] }, no: { oneOf: [atoms, { type: 'null' }] } } } } } },
  'heartbeat.v1.json': { title: 'Runtime heartbeat', type: 'object', additionalProperties: false, required: ['runtimeId', 'sdk', 'mode', 'state', 'policy', 'pending', 'startedAt'],
    properties: { runtimeId: { type: 'string', minLength: 1, maxLength: 64 },
      sdk: { type: 'object', required: ['language', 'version'], properties: { language: { enum: ['typescript', 'python', 'rust', 'cpp'] }, version: { type: 'string', maxLength: 32 } } },
      mode: { enum: ['paper', 'live'] }, state: { enum: ['running', 'paused', 'blocked', 'stopping', 'stopped'] },
      policy: { type: 'object', required: ['hash', 'flurboVersion'], properties: {
        hash: { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'SHA-256 of the canonical JSON of the effective local policy' },
        flurboVersion: { type: ['integer', 'null'], description: 'Version of the Flurbo policy the runtime applies' }, summary: { type: 'object' } } },
      pending: { type: 'integer', minimum: 0, maximum: 1000 }, startedAt: { type: 'integer' }, lastCycleAt: { type: ['integer', 'null'] },
      lastErrorCode: { type: ['string', 'null'], pattern: '^[A-Za-z_]{1,48}$' } } },
  'decision.v1.json': { title: 'flurbo.agent-runtime-decision.v1', description: 'A research decision reported by the runtime. Flurbo stores and displays it as self-reported.',
    type: 'object', additionalProperties: false, required: ['schema', 'decisionId', 'namespace', 'createdAt', 'outcome', 'reasons', 'provenance'],
    properties: { schema: { const: 'flurbo.agent-runtime-decision.v1' }, decisionId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' }, namespace: { type: 'string' },
      createdAt: { type: 'integer' }, outcome: { enum: ['trade', 'paper', 'abstain', 'rejected_by_policy'] },
      reasons: { type: 'array', maxItems: 16, items: { type: 'string', pattern: '^[A-Za-z_]{1,48}$' } },
      provenance: { type: 'object', required: ['kind', 'name'], properties: { kind: { enum: ['model', 'fixture', 'custom'] }, name: { type: 'string', maxLength: 64 } } },
      forecast: { description: 'flurbo.agent-forecast.v1 (packages/sdk/src/forecast.ts)', type: ['object', 'null'] },
      candidate: { type: ['object', 'null'] }, violations: { type: ['array', 'null'] }, execution: { type: ['object', 'null'] }, summary: { type: 'string', maxLength: 600 } } },
  'model-forecast.v1.json': { title: 'flurbo.agent-model-forecast.v1', description: 'Model output. See specs/research.md for the validation order.',
    type: 'object', additionalProperties: false, required: ['schema', 'abstain'],
    properties: { schema: { const: 'flurbo.agent-model-forecast.v1' }, abstain: { type: 'boolean' },
      abstainReason: { enum: [null, 'insufficient_evidence', 'contradictory_evidence', 'stale_evidence', 'ambiguous_rules', 'other'] },
      events: { type: 'array', items: { type: 'integer' } }, statesPpm: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 1000000 } },
      evidenceIds: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 64 } },
      assumptions: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 3, maxLength: 300 } },
      uncertainty: { type: 'string', minLength: 3, maxLength: 600 }, explanation: { type: 'string', minLength: 10, maxLength: 1200 } } },
  'journal.v1.json': { title: 'flurbo.agent-journal.v1', description: 'Local runtime journal. See specs/transactions.md.', type: 'object', required: ['schema', 'wallet', 'chainId', 'entries'],
    properties: { schema: { const: 'flurbo.agent-journal.v1' }, wallet: addr, chainId: { const: 10143 },
      entries: { type: 'array', items: { type: 'object', required: ['id', 'action', 'namespace', 'status', 'plannedAt'],
        properties: { id: { type: 'string' }, action: { enum: ['approve', 'buy', 'sell', 'redeem'] }, namespace: { type: 'string' }, claim: { oneOf: [claim, { type: 'null' }] },
          quantityAtoms: atoms, limitAtoms: atoms, deadline: { type: ['integer', 'null'] },
          status: { enum: ['planned', 'signed', 'broadcast', 'confirmed', 'reverted', 'mismatch', 'replaced', 'expired', 'abandoned'] },
          plannedAt: { type: 'integer' }, nonce: { type: ['integer', 'null'] },
          rawTransaction: { type: ['string', 'null'], description: 'Signed bytes, kept so recovery can resend the identical transaction' },
          hash: { oneOf: [hash, { type: 'null' }] }, costAtoms: { oneOf: [atoms, { type: 'null' }] }, decisionId: { type: ['string', 'null'] },
          report: { type: 'object', properties: { status: { enum: ['pending', 'accepted', 'rejected'] }, attempts: { type: 'integer' } } } } } } } },
  'error.v1.json': { title: 'Runtime API error', type: 'object', required: ['code', 'error', 'retryable'],
    properties: { code: { type: 'string' }, error: { type: 'string' }, retryable: { type: 'boolean' } } },
};
await mkdir(dir, { recursive: true });
for (const [name, schema] of Object.entries(schemas)) {
  const content = JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://flurbo.singu.online/protocol/schemas/' + name, ...schema }, null, 2) + '\n';
  if (check) { if ((await readFile(new URL(name, dir), 'utf8').catch(() => '')).replace(/\r\n/g, '\n') !== content) { console.error('out of date: ' + name); process.exitCode = 1; } }
  else await writeFile(new URL(name, dir), content);
}
if (!check) console.log(Object.keys(schemas).join(' '));
