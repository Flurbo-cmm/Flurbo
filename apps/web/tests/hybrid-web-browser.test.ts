import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const pool = '0x' + '44'.repeat(20), account = '0x' + '22'.repeat(20), now = Math.floor(Date.now() / 1000);
const questions = ['Will the first value be above four?', 'Will the second value be above four?', 'Will the third value fall?',
  'Will the fourth value hold?', 'Will the fifth value rise?', 'Will the sixth value close higher?'];
const markets = questions.map((question, eventIndex) => ({ id: `${pool}-${eventIndex}`, pool, poolTitle: 'Source pool',
  eventIndex, question, route: 'mechanical', closesAt: now + 7200, observationEndsAt: now + 10800 }));
const edge = (a: number, b: number, difference: number) => ({ a, b, joint: 300 + difference, independent: 300, difference, scope: 3 });
const web = (edges: unknown[]) => ({ schema: 'flurbo.hybrid-web.v1', pool, title: 'Source pool', closesAt: now + 7200,
  blockNumber: '200', blockHash: '0x' + '9'.repeat(64), observedAt: now, estimated: true, questions,
  nodes: questions.map((_, event) => ({ event, yes: 500 })), edges });

async function open(viewport: { width: number; height: number }, edges: unknown[], body: (page: any) => Promise<void>) {
  const { chromium } = await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.FLURBO_TEST_BROWSER });
  const errors: string[] = [];
  try {
    const page = await browser.newPage({ viewport });
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.route('**/*', async (route: any) => {
      const url = new URL(route.request().url()), path = url.pathname;
      if (path === '/api/auth/session') return route.fulfill({ json: { session: { address: account, method: 'passkey', expiresAt: Date.now() + 3600_000 } } });
      if (path === '/api/account/access') return route.fulfill({ json: { approved: true, testingTools: false } });
      if (path === '/api/account/wallets') return route.fulfill({ json: { account, wallets: [] } });
      if (path === '/api/account/portfolio-sources') return route.fulfill({ json: { account, wallets: [], agentWallets: [] } });
      if (path === '/api/market-directory') return route.fulfill({ json: {
        schema: 'flurbo.market-directory.v1', markets: [], oracleMarkets: [], hybridMarkets: markets } });
      if (path === `/api/hybrid/${pool}-0/web`) return route.fulfill({ json: web(edges) });
      if (path.endsWith('/analysis')) {
        const input = route.request().postDataJSON();
        return route.fulfill({ json: { schema: 'flurbo.hybrid-analysis.v1', pool, a: input.a, b: input.b, rule: input.rule,
          quantity: input.quantity, closed: false, blockNumber: '200', blockHash: '0x' + '9'.repeat(64), observedAt: now,
          values: { a: 500, b: 500, joint: 360, givenYes: 720, givenNo: 280, independent: 250, difference: 110 },
          reasons: {}, outcomes: ['no/no', 'no/yes', 'yes/no', 'yes/yes'].map(pair => ({ a: pair.split('/')[0], b: pair.split('/')[1],
            costAtoms: '500000', probability: 250, scenarioProbability: 250 })), sensitivity: [] } });
      }
      if (path.startsWith('/api/')) return route.fulfill({ status: 503, json: { error: 'Unavailable fixture' } });
      const relative = path.startsWith('/assets/') ? path.slice(1) : 'index.html';
      return route.fulfill({ body: await readFile(new URL('../dist/' + relative, import.meta.url)),
        contentType: relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css')
          ? 'text/css' : relative.endsWith('.woff2') ? 'font/woff2' : 'text/html' });
    });
    await page.goto(`https://flurbo.singu.online/markets/hybrid/${pool}/web`);
    await body(page);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}

const skip = !process.env.FLURBO_TEST_PLAYWRIGHT;
const links = [edge(0, 1, 60), edge(0, 2, -30), edge(1, 2, 10)];

test('web page lists every question and its links', { skip }, async () => {
  await open({ width: 1440, height: 1000 }, links, async page => {
    await page.getByRole('heading', { name: 'How these questions connect.' }).waitFor();
    for (let i = 0; i < questions.length; i += 1)
      assert.equal(await page.locator(`#web-node-${i}`).count(), 1);
    const label = await page.locator('#web-node-0').getAttribute('aria-label');
    assert.match(label, /Question 1: Will the first value be above four\?, Yes 50\.0%, linked to 2 questions/);
    assert.equal(await page.locator('.web-edge').count(), 3);
    await page.locator('#web-node-0').click();
    await page.getByRole('heading', { name: 'Moves most with' }).waitFor();
    await page.getByRole('button', { name: /second value.*\+6\.0%/ }).waitFor();
    await page.getByRole('link', { name: 'Open this market' }).waitFor();
  });
});

test('selecting an edge shows What if figures', { skip }, async () => {
  await open({ width: 1440, height: 1000 }, links, async page => {
    await page.locator('#web-node-0').click();
    await page.getByRole('button', { name: /second value.*\+6\.0%/ }).click();
    await page.getByText('If the other answer is Yes').waitFor();
    await page.getByText('72.0%').waitFor();
    await page.getByRole('link', { name: 'Build your thesis' }).waitFor();
  });
});

test('keyboard moves between linked nodes and escape clears', { skip }, async () => {
  await open({ width: 1440, height: 1000 }, links, async page => {
    await page.waitForFunction(() => { document.getElementById('web-node-0')?.focus(); return document.activeElement?.id === 'web-node-0'; });
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'web-node-1');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'web-node-0');
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Will the first value be above four?' }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('heading', { name: 'Source pool' }).waitFor();
  });
});

test('a pool with no links shows the empty state', { skip }, async () => {
  await open({ width: 1440, height: 1000 }, [], async page => {
    await page.locator('.web-empty').waitFor();
    assert.match(await page.locator('.web-empty').innerText(), /No questions in this pool are priced together yet/);
    assert.equal(await page.locator('.web-node').count(), 6);
  });
});

test('mobile width shows the list view', { skip }, async () => {
  await open({ width: 390, height: 844 }, links, async page => {
    await page.locator('.web-list').waitFor();
    assert.equal(await page.locator('.web-svg').count(), 0);
    assert.equal(await page.locator('.web-list-edge').count(), 6);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.locator('.web-list-edge').first().click();
    await page.getByText('If the other answer is Yes').waitFor();
  });
});
