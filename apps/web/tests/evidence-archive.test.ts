import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keccak256, stringToHex } from 'viem';
import { evidenceArchive } from '../server/evidence-archive.mjs';

const owner = '0x' + '11'.repeat(20), rules = '0x' + '55'.repeat(32);
const origin = 'https://flurbo.singu.online';

test('new evidence uploads are rate limited durably while existing content remains reusable', async () => {
  const db = new Map<string, string>(), counts = new Map<string, number>();
  const command = async (...a: any[]) => {
    if (a[0] === 'EVAL') { const value = (counts.get(a[3]) || 0) + 1; counts.set(a[3], value); return value; }
    if (a[0] === 'SET') { if (!db.has(a[1])) db.set(a[1], a[2]); return 'OK'; } return db.get(a[1]);
  };
  const input = { eventId: 'a', outcome: 2, statement: 'Public test fixture evidence only.', sourceURL: 'https://example.org/evidence', attachment: '' };
  let service = evidenceArchive(command, origin, () => 0);
  const first = await service.put(input, owner, rules);
  for (let i = 1; i < 20; i++) await service.put({ ...input, attachment: String(i) }, owner, rules);
  service = evidenceArchive(command, origin, () => 0);
  await assert.rejects(service.put({ ...input, attachment: 'over quota' }, owner, rules), /limit/);
  assert.equal((await service.put(input, owner, rules)).hash, first.hash);
  assert.equal(await service.get(first.hash), first.body);
});

test('evidence persists immutable bytes across service reconstruction and detects corruption', async () => {
  const db = new Map<string, string>(), command = async (...a: any[]) => { if (a[0] === 'EVAL') return 1; if (a[0] === 'SET') { if (!db.has(a[1])) db.set(a[1], a[2]); return 'OK'; } return db.get(a[1]); };
  const first = evidenceArchive(command, origin);
  const input = { eventId: 'a', outcome: 2, statement: 'Public fixture evidence, never a real market outcome.', sourceURL: 'https://github.com/ethereum/go-ethereum/releases', attachment: 'fixture' };
  const saved = await first.put(input, owner, rules), second = evidenceArchive(command, origin);
  assert.equal(await second.get(saved.hash), saved.body);
  assert.equal((await first.put(input, owner, rules)).hash, saved.hash);
  await assert.rejects(first.put({ ...input, sourceURL: 'file:///private' }, owner, rules));
  db.set([...db.keys()][0], 'corrupt'); await assert.rejects(second.get(saved.hash));
});

test('persisted evidence names are unchanged: URI path, body schema, Redis key and quota keys', async () => {
  const db = new Map<string, string>(), quotaKeys: string[] = [];
  const command = async (...a: any[]) => {
    if (a[0] === 'EVAL') { quotaKeys.push(a[3]); return 1; }
    if (a[0] === 'SET') { if (!db.has(a[1])) db.set(a[1], a[2]); return 'OK'; } return db.get(a[1]) ?? null;
  };
  const archive = evidenceArchive(command, origin, () => 7_200_000);
  const input = { eventId: 'a', outcome: 1, statement: 'Golden evidence naming check for the archive.', sourceURL: 'https://example.org/source', attachment: '' };
  const saved = await archive.put(input, owner, rules);
  assert.equal(saved.uri, `${origin}/api/pilot/evidence/${saved.hash}`);
  assert.equal(saved.hash, keccak256(stringToHex(saved.body)));
  assert.equal(JSON.parse(saved.body).schema, 'flurbo.pilot-evidence.v1');
  assert.deepEqual([...db.keys()], [`flurbo:pilot:evidence:v1:${saved.hash}`]);
  assert.deepEqual(quotaKeys, [`flurbo:pilot:evidence-quota:2:${owner}`, 'flurbo:pilot:evidence-quota:2:all']);
  assert.ok(quotaKeys.every(key => key.startsWith('flurbo:pilot:evidence-quota:')));
  const other = '0x' + 'ab'.repeat(32);
  db.set(`flurbo:pilot:evidence:v1:${other}`, saved.body);
  await assert.rejects(archive.get(other), /Evidence unavailable/);
  await assert.rejects(archive.get('0x1234'), /Invalid evidence hash/);
});
