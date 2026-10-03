import { encodeAbiParameters, keccak256, parseAbiParameters, stringToHex } from 'viem';
import { z } from 'zod';
import { eventDraftSchema, prepareEventDraft, type EventDraft } from './event-draft';

const repository = z.enum(['ethereum/go-ethereum', 'paradigmxyz/reth']);
const tag = z.string().regex(/^v\d{1,4}\.\d{1,4}\.\d{1,4}$/);
export const releaseTargetSchema = z.object({ repository, tag }).strict();
export type ReleaseTarget = z.infer<typeof releaseTargetSchema>;
export const MAX_RELEASE_BYTES = 1_000_000;
const sourceRule = 'github-stable-release-publication.v1';
const releaseSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  url: z.string(), html_url: z.string(), tag_name: z.string(),
  draft: z.boolean(), prerelease: z.boolean(), published_at: z.string().nullable(),
});

export function releaseEndpoint(input: unknown) {
  const target = releaseTargetSchema.parse(input);
  return `https://api.github.com/repos/${target.repository}/releases/tags/${target.tag}`;
}

/** Exact supported question template. A software release is not chain activation. */
export function releaseEvent(input: unknown, id: string, startsAt: number, endsAt: number): EventDraft['events'][number] {
  const target = releaseTargetSchema.parse(input);
  return {
    id, question: `Will ${target.repository} publish stable release ${target.tag} during the specified observation window?`,
    yesRule: 'YES requires the exact tagged release to be public, not a draft or prerelease, with published_at in [observationStartsAt, observationEndsAt).',
    noRule: 'NO requires reviewed evidence that no qualifying publication occurred throughout the full window. A missing API response is not proof of NO.',
    observationStartsAt: startsAt, observationEndsAt: endsAt,
    source: {
      publisher: target.repository.split('/')[0],
      referenceUrl: `https://github.com/${target.repository}/releases`,
      recordId: `${target.repository}@${target.tag}`,
      selectionRule: `${sourceRule}: match exact repository, tag, release ID and canonical API/HTML URLs.`,
      finalityRule: 'A retrieved release is candidate evidence only. Finalization requires the selected dispute oracle and completed challenge process.',
      revisionRule: 'Release edits, deletion or conflicting snapshots require review under the committed exception policy; never silently replace previously recorded evidence.',
    },
  };
}

export function releaseTargetForEvent(rawDraft: unknown, eventId: string) {
  const draft = eventDraftSchema.parse(rawDraft);
  const event = draft.events.find(item => item.id === eventId);
  if (!event) throw new Error('Unknown event ID');
  const [repo, releaseTag, extra] = event.source.recordId.split('@');
  if (extra !== undefined) throw new Error('Unsupported release record');
  const target = releaseTargetSchema.parse({ repository: repo, tag: releaseTag });
  const expected = releaseEvent(target, event.id, event.observationStartsAt, event.observationEndsAt);
  if (event.question !== expected.question || event.yesRule !== expected.yesRule || event.noRule !== expected.noRule
    || Object.entries(expected.source).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).some(([key, value]) => event.source[key as keyof typeof event.source] !== value)) {
    throw new Error('Event rules do not match the supported release template');
  }
  return { target, event };
}

/** Validate a fetched response. Does not authenticate caller-supplied evidence or settle a pool. */
export function observeRelease(rawDraft: unknown, eventId: string, httpStatus: number, body: string, fetchedAt: number) {
  const prepared = prepareEventDraft(rawDraft, fetchedAt);
  const { target, event } = releaseTargetForEvent(prepared.draft, eventId);
  const common = { schema: 'flurbo.github-release-observation.v1', draftHash: prepared.draftHash,
    eventId, endpoint: releaseEndpoint(target), fetchedAt, final: false as const };
  const unavailable = (reason: string) => ({ ...common, status: 'unavailable' as const, reason });
  if (httpStatus === 404) return { ...common, status: 'needs-review' as const, reason: 'Release not found. Absence is not a settled NO.' };
  if (httpStatus !== 200) return unavailable('Official source request failed; no outcome inferred.');
  if (new TextEncoder().encode(body).length > MAX_RELEASE_BYTES) return unavailable('Official source response exceeded the size limit.');
  let release: z.infer<typeof releaseSchema>;
  try { release = releaseSchema.parse(JSON.parse(body)); }
  catch { return unavailable('Official source response was malformed.'); }
  if (release.tag_name !== target.tag
    || release.url !== `https://api.github.com/repos/${target.repository}/releases/${release.id}`
    || release.html_url !== `https://github.com/${target.repository}/releases/tag/${target.tag}`) {
    return unavailable('Official source response does not match the requested release.');
  }
  if (release.draft || release.prerelease || release.published_at === null) {
    return { ...common, status: 'needs-review' as const, reason: 'No qualifying stable publication in this response; no outcome inferred.' };
  }
  const publishedAt = Date.parse(release.published_at) / 1000;
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(release.published_at) || !Number.isSafeInteger(publishedAt)
    || new Date(publishedAt * 1000).toISOString() !== release.published_at.replace('Z', '.000Z') || publishedAt > fetchedAt) {
    return unavailable('Official publication timestamp is invalid or in the future.');
  }
  if (publishedAt < event.observationStartsAt || publishedAt >= event.observationEndsAt) {
    return { ...common, status: 'needs-review' as const, reason: 'Publication is outside the event window; no outcome inferred.' };
  }
  const payloadHash = keccak256(stringToHex(body));
  const evidencePreimage = encodeAbiParameters(parseAbiParameters(
    'string domain, bytes32 draftHash, string eventId, string endpoint, uint64 fetchedAt, uint256 releaseId, uint64 publishedAt, bytes32 payloadHash',
  ), [common.schema, common.draftHash, eventId, common.endpoint, BigInt(fetchedAt), BigInt(release.id), BigInt(publishedAt), payloadHash]);
  return { ...common, status: 'candidate' as const, candidateOutcome: true as const,
    releaseId: release.id, publishedAt, payloadHash, evidencePreimage, evidenceHash: keccak256(evidencePreimage) };
}
