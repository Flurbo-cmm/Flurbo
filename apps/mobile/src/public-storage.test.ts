import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicStorage } from './public-storage.ts';
test('a failed pending write blocks the pre-signing durability barrier', async () => {
  const s = new PublicStorage(async () => { throw new Error('disk full'); });
  s.setItem('flurbo.pending', '{"hash":null}');
  await assert.rejects(s.flush(), /could not be saved/);
  assert.throws(() => s.setItem('flurbo.pending', 'retry'), /unavailable/);
});
test('public writes are ordered and survive rehydration', async () => {
  const writes: unknown[] = [], s = new PublicStorage(async (k,v) => { writes.push([k,v]); });
  s.setItem('flurbo.pending','first'); s.setItem('flurbo.pending','hash'); await s.flush();
  assert.deepEqual(writes,[['flurbo.pending','first'],['flurbo.pending','hash']]);
  const restored=new PublicStorage(async()=>{}); restored.hydrate([['flurbo.pending','hash']]);
  assert.equal(restored.getItem('flurbo.pending'),'hash');
});
