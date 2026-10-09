import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SHORTCUT_ACTIONS, shortcutFor } from '../src/shortcuts.ts';

const key = (k: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
const body = { tagName: 'BODY', isContentEditable: false };

test('board keys map to board actions', () => {
  const map: Record<string, string> = { '/': 'search', j: 'next', k: 'prev', Enter: 'open', y: 'yes', n: 'no', ']': 'pageNext', PageDown: 'pageNext', '[': 'pagePrev', PageUp: 'pagePrev', w: 'watch' };
  for (const [k, action] of Object.entries(map)) assert.equal(shortcutFor(key(k), body, 'board', false), action, k);
  assert.equal(shortcutFor(key('?', { shiftKey: true }), body, 'board', false), 'help');
  assert.equal(shortcutFor(key('b'), body, 'board', false), null);
});

test('market keys map to market actions', () => {
  const map: Record<string, string> = { y: 'yes', n: 'no', b: 'buy', s: 'sell', r: 'refresh' };
  for (const [k, action] of Object.entries(map)) assert.equal(shortcutFor(key(k), body, 'market', false), action, k);
  assert.equal(shortcutFor(key('?', { shiftKey: true }), body, 'market', false), 'help');
  assert.equal(shortcutFor(key('j'), body, 'market', false), null);
  assert.equal(shortcutFor(key('Enter'), body, 'market', false), null);
});

test('modifiers, text entry and open dialogs disable shortcuts', () => {
  for (const mod of ['ctrlKey', 'metaKey', 'altKey'] as const) assert.equal(shortcutFor(key('j', { [mod]: true }), body, 'board', false), null, mod);
  assert.equal(shortcutFor(key('Y', { shiftKey: true }), body, 'board', false), null);
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) assert.equal(shortcutFor(key('j'), { tagName, isContentEditable: false }, 'board', false), null, tagName);
  assert.equal(shortcutFor(key('j'), { tagName: 'DIV', isContentEditable: true }, 'board', false), null);
  assert.equal(shortcutFor(key('j'), body, 'board', true), null);
  assert.equal(shortcutFor(key('j'), null, 'board', false), 'next');
});

test('no shortcut can confirm, approve, send or submit', () => {
  for (const action of SHORTCUT_ACTIONS) assert.doesNotMatch(action, /confirm|approve|send|submit|sign|buyNow|pay/i);
});
