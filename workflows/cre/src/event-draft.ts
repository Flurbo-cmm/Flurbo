import { keccak256 } from 'viem';
import { z } from 'zod';
import { encodeEventDraft } from '../../../apps/web/server/settlement-publication.mjs';
export { eventDraftAbi } from '../../../apps/web/server/settlement-publication.mjs';

const text = (max: number) => z.string().min(1).max(max)
  .refine(value => value === value.trim(), 'Remove leading or trailing whitespace')
  .refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Control characters are not allowed');
const id = z.string().regex(/^[a-z0-9][a-z0-9:_-]{0,95}$/);
const timestamp = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const reference = text(2048).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash
      && !url.search && (!url.port || url.port === '443') && url.hostname.includes('.')
      && !/[\[\]:]/.test(url.hostname) && !/^\d+(\.\d+){3}$/.test(url.hostname)
      && !/(^|\.)(localhost|local|internal|test|invalid|example)$/.test(url.hostname);
  } catch { return false; }
}, 'Use a public HTTPS reference without credentials, query parameters or fragments');

// References are for review, never instructions to fetch an arbitrary URL.
// A future source adapter needs its own fixed endpoint and response validation.
const sourceSchema = z.object({
  publisher: text(160),
  referenceUrl: reference,
  recordId: text(256),
  selectionRule: text(2048),
  finalityRule: text(2048),
  revisionRule: text(2048),
}).strict();

export const eventDraftSchema = z.object({
  schema: z.literal('flurbo.event-draft.v1'),
  status: z.literal('draft'),
  chainId: z.literal(10143),
  clusterId: id,
  title: text(240),
  closesAt: timestamp,
  events: z.array(z.object({
    id,
    question: text(512),
    yesRule: text(2048),
    noRule: text(2048),
    observationStartsAt: timestamp,
    observationEndsAt: timestamp,
    source: sourceSchema,
  }).strict()).min(2).max(4),
  // Null is an explicit unanswered release question, not a default policy.
  exceptionPolicy: text(4096).nullable(),
  disputeModel: z.enum(['undecided', 'reviewer-panel', 'external-oracle', 'permissionless-voting']),
  disputePolicy: text(4096).nullable(),
}).strict().superRefine((draft, ctx) => {
  const seen = new Set<string>();
  for (const [bit, event] of draft.events.entries()) {
    const issue = (field: string, message: string) => ctx.addIssue({ code: 'custom', path: ['events', bit, field], message });
    if (seen.has(event.id)) issue('id', 'Event IDs must be unique');
    seen.add(event.id);
    if (draft.closesAt >= event.observationStartsAt) issue('observationStartsAt', 'Trading must close before every observation window');
    if (event.observationEndsAt <= event.observationStartsAt) issue('observationEndsAt', 'Observation end must follow its start');
    if (event.yesRule === event.noRule) issue('noRule', 'YES and NO rules must differ');
  }
  if (draft.disputeModel === 'undecided' && draft.disputePolicy !== null) {
    ctx.addIssue({ code: 'custom', path: ['disputePolicy'], message: 'Choose a dispute model before specifying its policy' });
  }
});

export type EventDraft = z.infer<typeof eventDraftSchema>;

// Explicit ABI field order makes commitments independent of JSON key order.
// This is a draft-domain commitment, NOT an existing pool settlementRulesHash.
export function prepareEventDraft(input: unknown, now: number) {
  const draft = eventDraftSchema.parse(input);
  timestamp.parse(now);
  const preimage = encodeEventDraft(draft);
  const blockers = [
    'No authenticated official-source report is attached to this draft.',
    'Rule text requires review; schema validation does not establish that outcomes are unambiguous or independent.',
    'This draft alone does not establish a deployed settlement controller, exception payouts or dispute enforcement.',
    'Pool binding, funding, supported claim structure and deployment verification are outstanding.',
  ];
  if (draft.closesAt <= now) blockers.push('Trading close has already passed; choose future dates for a new release.');
  if (draft.exceptionPolicy === null) blockers.push('Cancellation, missing-result and nonresolution policy is undecided.');
  if (draft.disputeModel === 'undecided') blockers.push('Dispute authority is undecided.');
  if (draft.disputePolicy === null) blockers.push('Voting eligibility, quorum, deadlines, bonds and escalation rules are unspecified.');
  return {
    status: 'draft' as const, deployable: false as const, draft,
    draftHash: keccak256(preimage), preimage,
    eventBits: draft.events.map((event, bit) => ({ id: event.id, bit })), blockers,
  };
}
