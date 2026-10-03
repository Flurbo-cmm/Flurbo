import { expect, test } from 'bun:test';
import { decodeAbiParameters } from 'viem';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventDraftAbi, prepareEventDraft } from '../src/event-draft';

// Offline validation fixtures. These questions are not proposed public markets.
const now = 1_800_000_000;
function fixture() {
  return {
    schema: 'flurbo.event-draft.v1', status: 'draft', chainId: 10143,
    clusterId: 'crypto-pilot', title: 'Offline governance fixtures', closesAt: now + 100,
    events: ['a', 'b'].map(id => ({
      id, question: `Will fixture proposal ${id} execute within its observation window?`,
      yesRule: 'A finalized execution log exists within the observation window.',
      noRule: 'Complete finalized source history contains no execution log within that window.',
      observationStartsAt: now + 200, observationEndsAt: now + 1000,
      source: { publisher: 'Offline fixture publisher', referenceUrl: 'https://github.com/fixture/results',
        recordId: `proposal-${id}`, selectionRule: 'Match the configured proposal ID and contract.',
        finalityRule: 'Require the configured finalized block evidence.', revisionRule: 'Reorganizations before finality invalidate the observation.' },
    })),
    exceptionPolicy: null, disputeModel: 'external-oracle', disputePolicy: null,
  };
}

test('draft commitment has its own domain, ordered event bits and no deployment authorization', () => {
  const result = prepareEventDraft(fixture(), now);
  const decoded = decodeAbiParameters(eventDraftAbi, result.preimage);
  expect(decoded[0]).toBe('flurbo.event-draft.v1');
  expect(decoded[1]).toBe(10143n);
  expect(decoded[5].map(event => event.id)).toEqual(['a', 'b']);
  expect(decoded[6]).toBe(false); expect(decoded[7]).toBe('');
  expect(result.eventBits).toEqual([{ id: 'a', bit: 0 }, { id: 'b', bit: 1 }]);
  expect(result.deployable).toBe(false);
  expect(result.blockers.join(' ')).toContain('Cancellation');
  expect('unsignedReport' in result).toBe(false);
});

test('JSON key order does not affect commitment; event order and every rule field do', () => {
  const draft = fixture();
  const hash = prepareEventDraft(draft, now).draftHash;
  const reordered = Object.fromEntries(Object.entries(draft).reverse());
  expect(prepareEventDraft(reordered, now).draftHash).toBe(hash);
  expect(prepareEventDraft({ ...draft, events: [...draft.events].reverse() }, now).draftHash).not.toBe(hash);
  for (const key of ['question', 'yesRule', 'noRule'] as const) {
    const changed = fixture(); changed.events[0][key] += ' Revised.';
    expect(prepareEventDraft(changed, now).draftHash).not.toBe(hash);
  }
  for (const key of Object.keys(draft.events[0].source) as (keyof typeof draft.events[0]['source'])[]) {
    const changed = fixture(); changed.events[0].source[key] += key === 'referenceUrl' ? '/v2' : ' Revised.';
    expect(prepareEventDraft(changed, now).draftHash).not.toBe(hash);
  }
  for (const key of ['observationStartsAt', 'observationEndsAt'] as const) {
    const changed = fixture(); changed.events[0][key]++;
    expect(prepareEventDraft(changed, now).draftHash).not.toBe(hash);
  }
  for (const change of [{ clusterId: 'another-cluster' }, { title: 'Another title' }, { closesAt: now + 101 },
    { exceptionPolicy: 'Explicit proposed exception policy' }, { disputeModel: 'reviewer-panel' }, { disputePolicy: 'Explicit proposed dispute policy' }]) {
    expect(prepareEventDraft({ ...draft, ...change }, now).draftHash).not.toBe(hash);
  }
});

test('duplicate IDs, unknown fields, live status, wrong chains and invalid chronology fail closed', () => {
  const draft = fixture();
  for (const change of [{ events: [draft.events[0], draft.events[0]] }, { events: [] }, { events: [draft.events[0]] },
    { unexpected: true }, { status: 'published' }, { chainId: 143 }, { closesAt: now + 200 }, { closesAt: 1.5 },
    { events: [{ ...draft.events[0], observationEndsAt: now + 199 }, draft.events[1]] },
    { events: [{ ...draft.events[0], noRule: draft.events[0].yesRule }, draft.events[1]] },
    { events: [{ ...draft.events[0], question: ' leading whitespace' }, draft.events[1]] },
    { title: 'Invisible\u0000text' }, { disputeModel: 'undecided', disputePolicy: 'Unselected authority' }]) {
    expect(() => prepareEventDraft({ ...draft, ...change }, now)).toThrow();
  }
  expect(() => prepareEventDraft(draft, NaN)).toThrow();
});

test('unsafe or credential-bearing source references are rejected without fetching', () => {
  for (const referenceUrl of ['http://github.com/result', 'https://user:secret@github.com/result',
    'https://github.com/result?api_key=secret', 'https://github.com/result#fragment',
    'https://127.0.0.1/result', 'https://2130706433/result', 'https://[::1]/result',
    'https://service.internal/result', 'file:///etc/passwd', 'https://github.com:8443/result']) {
    const draft = fixture(); draft.events[0].source.referenceUrl = referenceUrl;
    expect(() => prepareEventDraft(draft, now)).toThrow();
  }
});

test('expired drafts remain reproducible but blocked; filled policy text cannot authorize deployment', () => {
  const draft = { ...fixture(), exceptionPolicy: 'Reviewed text still needs contract enforcement.', disputePolicy: 'Oracle integration still requires verified deployment.' };
  const fresh = prepareEventDraft(draft, now), expired = prepareEventDraft(draft, now + 101);
  expect(expired.draftHash).toBe(fresh.draftHash);
  expect(expired.blockers.join(' ')).toContain('already passed');
  expect(fresh.deployable).toBe(false);
  expect(fresh.blockers.join(' ')).toContain('does not establish a deployed settlement controller');
});

test('local review CLI reports valid drafts as blocked and rejects malformed files', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'flurbo-event-draft-'));
  const file = join(folder, 'draft.json');
  const command = fileURLToPath(new URL('../scripts/review-event-draft.ts', import.meta.url));
  try {
    await writeFile(file, JSON.stringify(fixture()), 'utf8');
    const valid = Bun.spawnSync([process.execPath, command, file]);
    expect(valid.exitCode).toBe(0);
    const result = JSON.parse(valid.stdout.toString());
    expect(result.deployable).toBe(false);
    expect(result.draftHash).toBe(prepareEventDraft(fixture(), now).draftHash);
    expect(result.eventBits).toHaveLength(2);
    await writeFile(file, '{"private":"DO_NOT_ECHO", invalid', 'utf8');
    const invalid = Bun.spawnSync([process.execPath, command, file]);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr.toString()).not.toContain('DO_NOT_ECHO');
    expect(Bun.spawnSync([process.execPath, command]).exitCode).toBe(1);
  } finally {
    await unlink(file); await rmdir(folder);
  }
});
