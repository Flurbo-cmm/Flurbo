import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { retiredKeys, wipeRetiredCollections } from '../scripts/wipe-retired-collections.mjs';

const record = JSON.parse(await readFile(new URL('../../../config/retired-collections.json', import.meta.url), 'utf8'));
const pilot = JSON.parse(await readFile(new URL('../../../config/pilot-testnet.json', import.meta.url), 'utf8'));

// Redis MATCH with only '*' wildcards, which is all the script uses.
function glob(pattern: string, key: string) {
  const parts = pattern.split('*'), last = parts.at(-1)!;
  if (!key.startsWith(parts[0])) return false;
  let at = parts[0].length;
  for (const part of parts.slice(1, -1)) { const found = key.indexOf(part, at); if (found < 0) return false; at = found + part.length; }
  return key.length - at >= last.length && key.endsWith(last);
}

function memory(entries: Record<string, string>) {
  const db = new Map(Object.entries(entries));
  const command = async (op: string, ...args: any[]) => {
    if (op === 'EXISTS') return db.has(args[0]) ? 1 : 0;
    if (op === 'GET') return db.get(args[0]) ?? null;
    if (op === 'DEL') return db.delete(args[0]) ? 1 : 0;
    if (op === 'SCAN') return ['0', [...db.keys()].filter(key => glob(String(args[2]), key))];
    throw Error('unexpected ' + op);
  };
  return { db, command };
}

test('retired collection data is found exactly, deleted only on request, and kept pools are refused', async () => {
  const [september, october] = record.collections.map((c: any) => c.manifest);
  const evidence = (draftHash: string) => JSON.stringify({ schema: 'flurbo.pilot-evidence.v1', draftHash, statement: 'private-looking text' });
  const kept = {
    [`flurbo:pilot:index:v1:${pilot.pool}`]: 'keep', ['flurbo:pilot:index:v1:' + record.keep[1]]: 'keep',
    ['flurbo:pilot:evidence:v1:0x' + '11'.repeat(32)]: evidence(pilot.draftHash), 'flurbo:agents:v1:account': 'keep', 'flurbo:auth:v1:session:x': 'keep',
  };
  const retired = {
    ...Object.fromEntries(retiredKeys(september).slice(0, 4).map(k => [k, 'old'])), [retiredKeys(october)[0]]: 'old',
    ['flurbo:pilot:evidence:v1:0x' + '22'.repeat(32)]: evidence(september.draftHash), ['flurbo:pilot:evidence:v1:0x' + '33'.repeat(32)]: evidence(october.draftHash),
    [`flurbo:evidence-beta:v1:${october.pool}:${october.rulesHash}:event-0`]: 'old',
  };
  const { db, command } = memory({ ...kept, ...retired, [`flurbo:unknown:${october.pool}`]: 'review' });
  const keep = [pilot.pool, ...record.keep];

  const dry = await wipeRetiredCollections({ command, retired: record.collections, keep });
  assert.equal(dry.mode, 'dry-run'); assert.equal(dry.deleted, 0); assert.equal(db.size, Object.keys(kept).length + Object.keys(retired).length + 1);
  assert.deepEqual(new Set(dry.keys.filter((r: any) => r.deletable).map((r: any) => r.key)), new Set(Object.keys(retired)));
  assert.deepEqual(dry.leftForReview, [`flurbo:unknown:${october.pool}`]);
  assert.ok(!JSON.stringify(dry).includes('private-looking text'));

  const done = await wipeRetiredCollections({ command, retired: record.collections, keep, remove: true });
  assert.equal(done.deleted, Object.keys(retired).length);
  assert.deepEqual([...db.keys()].sort(), [...Object.keys(kept), `flurbo:unknown:${october.pool}`].sort());

  await assert.rejects(wipeRetiredCollections({ command, retired: [{ label: 'Release milestones', manifest: pilot }], keep }), /kept/);
});
