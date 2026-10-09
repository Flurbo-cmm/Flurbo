import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const WEB = fileURLToPath(new URL('../', import.meta.url));
const DIST = join(WEB, 'dist');
const KB = 1024;
const BUDGET = { landingJs: 140 * KB, css: 30 * KB, markets: 45 * KB, loader: 8 * KB, motion: 45 * KB, fonts: 6 };

async function newestSource(dir: string): Promise<number> {
  let newest = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? await newestSource(path) : (await stat(path)).mtimeMs);
  }
  return newest;
}
async function freshDist(): Promise<string | null> {
  const index = await stat(join(DIST, 'index.html')).catch(() => null);
  if (!index) return 'dist/index.html is missing; run vite build first';
  if (await newestSource(join(WEB, 'src')) > index.mtimeMs) return 'dist is older than src; run vite build first';
  return null;
}
const gz = async (file: string) => gzipSync(await readFile(join(DIST, file))).length;

test('production bundle stays inside the budgets', async t => {
  const reason = await freshDist();
  if (reason) { t.skip(reason); return; }
  const html = await readFile(join(DIST, 'index.html'), 'utf8');
  const firstLoad = [...html.matchAll(/<script[^>]+src="\/([^"]+\.js)"|<link[^>]+rel="modulepreload"[^>]+href="\/([^"]+\.js)"/g)].map(m => m[1] ?? m[2]);
  const css = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="\/([^"]+\.css)"/g)].map(m => m[1]);
  const assets = await readdir(join(DIST, 'assets'));
  const sizes: Record<string, number> = {};
  sizes.landingJs = (await Promise.all(firstLoad.map(gz))).reduce((a, b) => a + b, 0);
  assert.equal(css.length, 1, 'one stylesheet');
  sizes.css = await gz(css[0]);
  const chunk = (prefix: string) => assets.find(a => a.startsWith(prefix + '-') && a.endsWith('.js'));
  for (const [name, prefix] of [['markets', 'Markets'], ['loader', 'ContourLoader'], ['motion', 'motion']] as const) {
    const file = chunk(prefix);
    assert.ok(file, `${prefix} chunk exists`);
    sizes[name] = await gz('assets/' + file);
  }
  sizes.fonts = assets.filter(a => a.endsWith('.woff2')).length;
  t.diagnostic(JSON.stringify(sizes));
  for (const [name, limit] of Object.entries(BUDGET)) assert.ok(sizes[name] <= limit, `${name} ${sizes[name]} exceeds ${limit}`);
});
