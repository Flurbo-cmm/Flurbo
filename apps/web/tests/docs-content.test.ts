import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');
const docs = await read('../src/pages/Docs.tsx');
const guide = await read('../src/pages/FirstBotGuide.tsx');
const both = docs + guide;
const sectionIds = [...both.matchAll(/<section id="([a-z0-9-]+)"/g)].map(match => match[1]);

test('every section the app links to exists on the docs page', async () => {
  const sources = (await Promise.all(['../src/', '../server/', '../shared/'].map(async dir => {
    const files = await readdir(new URL(dir, import.meta.url), { recursive: true });
    return Promise.all(files.filter(file => /\.(tsx?|mjs)$/.test(file)).map(file => read(dir + file.replaceAll('\\', '/'))));
  }))).flat().join('\n');
  const linked = new Set([...sources.matchAll(/\/docs#([a-z0-9-]+)/g)].map(match => match[1]));
  assert.ok(linked.size > 0);
  for (const id of linked) assert.ok(sectionIds.includes(id), `missing section #${id}`);
});

test('the contents list and the sections match one to one', () => {
  const listed = [...docs.matchAll(/\['([a-z0-9-]+)', '[^']+'(?:, '[^']+')?\]/g)].map(match => match[1]);
  assert.deepEqual([...listed].sort(), [...sectionIds].sort());
  assert.equal(new Set(sectionIds).size, sectionIds.length);
});

test('every screenshot is imported, sized and present, and none is left unused', async () => {
  const sizes = await read('../src/pages/docs-media/sizes.ts');
  const files = (await readdir(new URL('../src/pages/docs-media/', import.meta.url))).filter(file => file.endsWith('.png'));
  const imported = [...both.matchAll(/from '\.\/docs-media\/([a-z0-9-]+)\.png'/g)].map(match => match[1]);
  assert.ok(imported.length >= 20);
  for (const name of imported) {
    assert.ok(files.includes(`${name}.png`), `${name}.png is missing`);
    assert.ok(sizes.includes(`'${name}':`), `${name} has no size`);
  }
  for (const file of files) assert.ok(imported.includes(file.slice(0, -4)), `${file} is not used`);
});

test('the guide describes the current pools only', () => {
  for (const retired of [/reviewer panel/i, /activity pool/i, /at least two/i, /settlement bot/i, /100 shares per trade/i, /collect(?:ion)? (?:in|from) portfolio/i])
    assert.doesNotMatch(docs, retired);
  for (const current of ['Reality.eth', 'Kleros', 'Exactly one', 'Nothing was sent', 'Collect on market page', '20 shares',
    'commission', 'Yes and No together cost at most 1 plus the commission'])
    assert.ok(docs.includes(current), `expected "${current}"`);
  assert.doesNotMatch(docs, /add up to 1 before price impact/);
  assert.doesNotMatch(docs, /slightly more than 1/);
});

test('the guide explains use, not how Flurbo is built', () => {
  for (const term of [/LMSR/i, /logarithmic/i, /scoring rule/i, /variable elimination/i, /factor(?:ed|s)\b/i, /induced width/i,
    /elimination order/i, /cost function/i, /truth table/i, /bitmap/i, /\bRedis\b/i, /Upstash/i, /\bRender\b/,
    /worker/i, /keeper/i, /litepaper/i, /LITEPAPER/])
    assert.doesNotMatch(docs, term);
});

test('the guide has no em dashes', () => {
  assert.doesNotMatch(both, /—/);
});
