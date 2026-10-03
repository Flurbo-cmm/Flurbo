import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rememberReturnPath, safeReturnPath, takeReturnPath } from '../src/return-path.ts';

test('only same-origin Flurbo app paths are accepted as a return destination', () => {
  for (const path of ['/markets', '/markets/pilot/0', '/markets/practice-' + 'ab'.repeat(20) + '/1?answer=no',
    '/markets/pilot/2?challenge=1', '/portfolio', '/fund', '/access', '/agents', '/agents/558b8e5f-b175-4759-850d-e1a9e5948cda']) {
    assert.equal(safeReturnPath(path), path, path);
  }
  for (const path of ['https://evil.example/markets', '//evil.example/markets', '/markets/pilot/9', '/markets/unknown/1', '/markets/rehearsal/3/thesis', '/login',
    '/docs', '/markets?next=https://evil.example', '/markets/pilot/0?answer=no&x=1', '/agents/x', 'markets', '', null, 42, '/'.padEnd(300, 'a')]) {
    assert.equal(safeReturnPath(path), null, String(path));
  }
});

test('a remembered destination is consumed once and unsafe values are never stored', () => {
  const store = new Map<string, string>();
  const original = (globalThis as any).sessionStorage;
  (globalThis as any).sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) };
  try {
    rememberReturnPath('/markets/pilot/1');
    assert.equal(takeReturnPath(), '/markets/pilot/1');
    assert.equal(takeReturnPath(), null);
    rememberReturnPath('https://evil.example');
    assert.equal(takeReturnPath(), null);
  } finally { (globalThis as any).sessionStorage = original; }
});
