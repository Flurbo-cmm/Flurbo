import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { pilotFixture, owner } from './pilot-fixture.ts';

const skip = !process.env.FLURBO_TEST_PLAYWRIGHT;
const ORIGIN = 'https://flurbo.singu.online';

async function setup(viewport: { width: number; height: number }) {
  const { chromium } = await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.FLURBO_TEST_BROWSER });
  const f = pilotFixture(Math.floor(Date.now() / 1000), 4), errors: string[] = [];
  f.manifest.publication.mode = 'rehearsal';
  const closesAt = f.manifest.publication.draft.closesAt;
  const groups = Array.from({ length: 13 }, (_, i) => { const pool = '0x' + (0x20 + i).toString(16).padStart(2, '0').repeat(20); return { namespace: 'practice-' + pool.slice(2), label: `Collection ${i + 1}`, pool, closesAt }; });
  const oraclePool = '0x' + '44'.repeat(20);
  const oracleMarkets = [{ id: 'oracle-board-0', pool: oraclePool, poolTitle: 'Source pool', eventIndex: 0, question: 'Will the source block be even?', closesAt: closesAt + 600, observationEndsAt: closesAt + 1200 }];
  const page = await browser.newPage({ viewport });
  page.on('pageerror', (e: Error) => errors.push(e.message));
  await page.route('**/*', async (route: any) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/account/access') return route.fulfill({ json: { approved: true, testingTools: false } });
    if (path === '/api/auth/session') return route.fulfill({ json: { session: { address: owner, method: 'passkey', expiresAt: Date.now() + 3600000 } } });
    if (path === '/api/market-directory') return route.fulfill({ json: { schema: 'flurbo.market-directory.v1', markets: groups, oracleMarkets } });
    if (path === '/api/oracle/oracle-board-0/market') return route.fulfill({ json: { schema: 'flurbo.oracle-market.v1', id: 'oracle-board-0', pool: oraclePool, marketNow: Math.floor(Date.now() / 1000), funded: true, resolved: false, prices: { yes: '450000', no: '550000' } } });
    const group = groups.find(g => path.startsWith('/api/' + g.namespace + '/'));
    if (group && path.endsWith('/markets')) { const v = await f.service.markets(); return route.fulfill({ json: { ...v, manifest: { ...v.manifest, pool: group.pool } } }); }
    if (path.startsWith('/api/')) return route.fulfill({ status: 503, json: { error: 'Unused fixture endpoint' } });
    const relative = path.startsWith('/assets/') ? path.slice(1) : 'index.html';
    return route.fulfill({ body: await readFile(new URL('../dist/' + relative, import.meta.url)), contentType: relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.woff2') ? 'font/woff2' : 'text/html' });
  });
  return { browser, page, errors };
}
const ready = (page: any) => page.locator('[data-market-count="53"]').waitFor({ timeout: 30000 });
const tileLinks = (page: any) => page.locator('.market-card .tile-q a').evaluateAll((links: HTMLAnchorElement[]) => links.map(a => a.getAttribute('href')));

test('the board fits one screen at every common size and never scrolls sideways', { skip }, async () => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]) {
    const { browser, page, errors } = await setup(viewport);
    try {
      await page.goto(ORIGIN + '/markets');
      await ready(page);
      await page.waitForFunction(() => { const root = document.querySelector('.app-root') as HTMLElement | null; return !!root && !root.inert && !document.querySelector('.contour-loader'); });
      const size = await page.evaluate(() => ({ height: document.scrollingElement!.scrollHeight, inner: innerHeight, width: document.documentElement.scrollWidth, innerWidth }));
      assert.ok(size.height <= size.inner + 1, `${viewport.width}x${viewport.height}: page scrolls to ${size.height}`);
      assert.ok(size.width <= size.innerWidth, `${viewport.width}x${viewport.height}: sideways ${size.width}`);
      const board = page.getByRole('region', { name: 'Markets', exact: true });
      const box = await board.boundingBox();
      assert.ok(box && box.y >= 0 && box.y + box.height <= viewport.height + 1, `${viewport.width}x${viewport.height}: board outside the viewport`);
      assert.ok(await page.locator('.market-card').count() >= 6, `${viewport.width}x${viewport.height}: too few tiles`);
      await page.getByRole('navigation', { name: 'Pages' }).waitFor();
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  }
});

test('categories, pages, search and keys keep their state in the URL', { skip }, async () => {
  const { browser, page, errors } = await setup({ width: 1440, height: 900 });
  try {
    await page.goto(ORIGIN + '/markets');
    await ready(page);
    const categories = page.getByRole('navigation', { name: 'Market categories' });
    await categories.getByRole('link', { name: /^Other/ }).click();
    await page.waitForURL(url => new URL(url).searchParams.get('category') === 'other');
    assert.deepEqual(await tileLinks(page), ['/markets/oracle/oracle-board-0']);
    assert.equal(await categories.getByRole('link', { name: /^Other/ }).getAttribute('aria-current'), 'page');

    await page.goto(ORIGIN + '/markets?category=practice&page=2');
    await ready(page);
    const pager = page.getByRole('navigation', { name: 'Pages' });
    assert.equal(await pager.getByRole('button', { name: 'Page 2', exact: true }).getAttribute('aria-current'), 'page');
    const second = await tileLinks(page);
    await page.locator('body').press(']');
    await page.waitForURL(url => new URL(url).searchParams.get('page') === '3');
    assert.notDeepEqual(await tileLinks(page), second);
    await page.locator('body').press('[');
    await page.waitForURL(url => new URL(url).searchParams.get('page') === '2');
    assert.deepEqual(await tileLinks(page), second);

    await page.locator('body').press('/');
    assert.equal(await page.getByRole('textbox', { name: 'Search markets' }).evaluate((e: HTMLInputElement) => e === document.activeElement), true);
    await page.keyboard.type('night');
    await page.waitForFunction(() => !new URL(location.href).searchParams.has('page'));
    assert.equal(new URL(page.url()).searchParams.get('q'), 'night');
    await page.getByRole('textbox', { name: 'Search markets' }).fill('');

    await page.goto(ORIGIN + '/markets?page=2');
    await ready(page);
    const target = (await tileLinks(page))[0];
    await page.locator(`.market-card .tile-q a[href="${target}"]`).click();
    await page.waitForURL('**' + target);
    await page.goBack();
    await page.waitForURL(url => new URL(url).pathname === '/markets' && new URL(url).searchParams.get('page') === '2');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('a short window falls back to a scrolling list without a pager', { skip }, async () => {
  const { browser, page, errors } = await setup({ width: 1280, height: 500 });
  try {
    await page.goto(ORIGIN + '/markets');
    await ready(page);
    await page.waitForFunction(() => document.querySelectorAll('.market-card').length === 53);
    assert.equal(await page.getByRole('navigation', { name: 'Pages' }).count(), 0);
    assert.ok(await page.evaluate(() => document.scrollingElement!.scrollHeight > innerHeight));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
