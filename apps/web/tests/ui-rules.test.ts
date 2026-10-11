import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]))).flat();
}
const rel = (file: string) => relative(SRC, file).split(sep).join('/');
const text = (file: string) => readFile(file, 'utf8');

// Operator pages may keep dropdowns and their own wide tables.
const OPERATOR_PAGES = ['Workspace.tsx', 'Metrics.tsx', 'MetricsSummary.tsx', 'LearningPool.tsx', 'LearningExecution.tsx', 'LearningComparison.tsx'];
const OPERATOR_SELECTORS = /^(\.(metrics|workspace|ws|learning|comparison|operator)[\w-]*)/;
const BANNED = /\b(bet|betting|wager|odds|jackpot|gamble|gambling|punt|parlay|degen|win big|cash out|lock it in|hot|streak|boost)\b/i;

test('no em or en dashes anywhere in the web source', async () => {
  const bad: string[] = [];
  for (const file of await files(SRC)) if (/\.(tsx?|css|mjs|json)$/.test(file) && /[\u2013\u2014]/.test(await text(file))) bad.push(rel(file));
  assert.deepEqual(bad, []);
});

test('member copy never uses gambling vocabulary', async () => {
  const bad: string[] = [];
  for (const file of await files(SRC)) {
    const path = rel(file);
    if (!/^(pages|components|landing)\//.test(path) || !/\.tsx?$/.test(path) || OPERATOR_PAGES.includes(path.slice(6)) || path === 'components/MetricsCharts.tsx') continue;
    const match = (await text(file)).match(BANNED);
    if (match) bad.push(`${path}: ${match[0]}`);
  }
  assert.deepEqual(bad, []);
});

test('the serif face is gone', async () => {
  const bad: string[] = [];
  for (const file of await files(SRC)) if (/Cormorant|serif-accent/.test(await text(file))) bad.push(rel(file));
  assert.deepEqual(bad, []);
});

test('member pages render no dropdowns', async () => {
  const bad: string[] = [];
  for (const file of await files(SRC)) {
    const path = rel(file);
    const member = (/^pages\/[^/]+\.tsx$/.test(path) && !OPERATOR_PAGES.includes(path.slice(6))) || /^components\/market\//.test(path) || /^landing\//.test(path);
    if (!member) continue;
    const source = await text(file);
    if (/<select[\s>]/.test(source) || /components\/ui\/Select['"]/.test(source) || /from ['"]\.\/ui\/Select['"]/.test(source)) bad.push(path);
  }
  assert.deepEqual(bad, []);
});

test('no stylesheet scrolls sideways outside operator tables', async () => {
  const bad: string[] = [];
  for (const file of await files(SRC)) {
    // The operator workspace injects this sheet into its own shadow root around the legacy dashboard markup.
    if (!file.endsWith('.css') || rel(file) === 'pages/workspace-core.css') continue;
    const css = (await text(file)).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const block of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/overflow-x\s*:\s*(auto|scroll)/.test(block[2])) continue;
      const selectors = block[1].trim().split(',').map(s => s.trim()).filter(Boolean);
      if (!selectors.every(s => OPERATOR_SELECTORS.test(s))) bad.push(`${rel(file)}: ${block[1].trim()}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('dependencies match the motion and type decisions', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.match(deps['framer-motion'] ?? '', /^\d+\.\d+\.\d+$/);
  assert.match(deps['@fontsource/ibm-plex-mono'] ?? '', /^\d+\.\d+\.\d+$/);
  assert.match(deps['@fontsource/geist-pixel'] ?? '', /^\d+\.\d+\.\d+$/);
  assert.equal(deps.gsap, undefined);
  assert.equal(deps['@fontsource/cormorant-garamond'], undefined);
});

test('logo geometry is unchanged', async () => {
  const source = await text(join(SRC, 'components', 'BrandLogo.tsx'));
  for (const line of [
    "  { d: 'M11 19C18 7 39 5 51 14c10 8 7 29-4 38-11 10-31 4-39-9-6-10-3-18 3-24Z', width: 4.5 },",
    "  { d: 'M20 19c8-6 22-4 27 5 5 9-2 20-12 23-10 3-20-3-21-13-1-6 1-11 6-15Z', width: 4.5 },",
    "  { d: 'M27 27c6-4 14 0 14 7-1 6-9 9-14 5-5-4-5-9 0-12Z', width: 5.5 },",
    "export const LOCKUP = { markTransform: 'translate(18 18) scale(1.9)', dot: { cx: 98, cy: 146, r: 4 }, viewBox: '20 27 416 125' } as const;",
    "export const INK = '#14271d';",
    "export const IVORY = '#f5f4ec';",
    "export const LIME = '#d9f76d';",
    '<text x="170" y="111" fill={ink} fontFamily="Space Grotesk, Arial, sans-serif" fontSize="102" fontWeight="560" letterSpacing="-6.2">flurbo</text>',
  ]) assert.ok(source.includes(line), line);
});
