import { createHash } from 'node:crypto';
import { EVIDENCE_SCHEMA, type EvidenceRecord } from '../src/research.ts';

// Test-only complete capture with a deliberately declared synthetic publisher time.
export function evidenceFixture(overrides: Partial<Omit<EvidenceRecord, 'retrievedAt'>> = {}): Omit<EvidenceRecord, 'retrievedAt'> {
  const excerpt = overrides.excerpt ?? 'Fixture release notes for both requested events.';
  const url = overrides.url ?? 'https://example.org/release-notes';
  return { schema: EVIDENCE_SCHEMA, id: 'src-1', url, requestedUrl: url, finalUrl: url, title: 'Fixture release notes', publisher: 'example.org',
    publisherReleasedAt: Math.floor(Date.now() / 1000) - 60, httpLastModified: null, eventIds: [0, 1], completeDocument: true,
    capturedBytes: Buffer.byteLength(excerpt), contentSha256: createHash('sha256').update(excerpt).digest('hex'), excerpt, ...overrides };
}
