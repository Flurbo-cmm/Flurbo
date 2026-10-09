import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { EXAMPLE } from '../src/landing/example-market.ts';

// Section 12.2: the landing hero fits the first viewport, the example market answers "Assume B", and the proof
// links point at the real pool. The page asks the API only who is signed in and whether access is open.
const skip = !process.env.FLURBO_TEST_PLAYWRIGHT;
const ALLOWED = new Set(['/api/auth/session', '/api/account/access', '/api/preview']);
const inside = async (page: any, locator: any) => {
  const box = await locator.boundingBox(), size = page.viewportSize();
  return !!box && box.y >= 0 && box.x >= 0 && box.y + box.height <= size.height && box.x + box.width <= size.width;
};

test('landing hero, example market, proof links and anchors work on desktop and mobile without extra API reads', { skip }, async () => {
  const { chromium } = await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.FLURBO_TEST_BROWSER });
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport }), errors: string[] = [], api: string[] = [];
      page.on('pageerror', (error: Error) => errors.push(error.message));
      await page.route('**/*', async (route: any) => {
        const path = new URL(route.request().url()).pathname;
        if (path.startsWith('/api/')) api.push(path);
        if (path === '/api/auth/session') return route.fulfill({ json: { session: null } });
        if (path === '/api/preview') return route.fulfill({ json: { inviteOnly: true, applicationUrl: null } });
        if (path.startsWith('/api/')) return route.fulfill({ status: 503, json: { error: 'Not used by the landing page' } });
        const file = path.startsWith('/assets/') ? path.slice(1) : 'index.html';
        return route.fulfill({ body: await readFile(new URL('../dist/' + file, import.meta.url)), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.woff2') ? 'font/woff2' : 'text/html' });
      });
      await page.goto('https://flurbo.singu.online/');
      const heading = page.getByRole('heading', { level: 1, name: 'Price how events connect.' });
      await heading.waitFor();
      const lede = page.getByText('Trade single questions or linked outcomes from one shared pool. Every price, rule and result is public.', { exact: true });
      const cta = page.getByRole('main').getByRole('link', { name: 'Get early access', exact: true }).first();
      const demo = page.getByRole('region', { name: 'Example market. Illustrative numbers.' });
      await demo.waitFor();
      await page.waitForTimeout(300);
      for (const [name, locator] of [['headline', heading], ['subtext', lede], ['call to action', cta]] as const)
        assert.ok(await inside(page, locator), `${viewport.width}: ${name} is in the first viewport`);
      assert.equal(await cta.getAttribute('href'), '/signup');
      if (viewport.width >= 1024) assert.ok(await inside(page, demo), 'the whole example sits beside the headline');
      else assert.ok(((await demo.boundingBox())?.y ?? Infinity) < viewport.height, 'the example starts in the first viewport');

      const readout = demo.getByRole('status');
      await demo.getByRole('button', { name: 'Goes live', exact: true }).click();
      assert.match(await readout.innerText(), /73\.3%/);
      await demo.getByRole('button', { name: 'Doesn’t go live', exact: true }).click();
      assert.match(await readout.innerText(), /25\.7%/);
      await demo.getByRole('button', { name: 'No assumption', exact: true }).click();
      assert.match(await readout.innerText(), /40(\.0)?%/);

      const proof = page.getByRole('button', { name: 'Show the proof', exact: true });
      assert.equal(await proof.getAttribute('aria-expanded'), 'false');
      await proof.click();
      const panel = page.getByRole('region', { name: 'Proof for the example market' });
      await panel.waitFor();
      const hrefs: string[] = await panel.getByRole('link').evaluateAll((links: HTMLAnchorElement[]) => links.map(link => link.href.toLowerCase()));
      assert.ok(hrefs.some(href => href.includes(EXAMPLE.proofPool.toLowerCase())), 'a proof link opens the live pool');
      assert.ok(hrefs.some(href => href.includes(EXAMPLE.proofQuestionTx.toLowerCase())), 'a proof link opens the Reality.eth question');

      for (const id of ['the-idea', 'how-it-works', 'faq']) assert.equal(await page.locator('#' + id).count(), 1, `#${id} exists`);
      assert.equal(await page.locator('details', { has: page.locator('summary') }).filter({ hasText: 'How do I get access?' }).count(), 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no horizontal scroll');
      assert.deepEqual([...new Set(api)].filter(path => !ALLOWED.has(path)), [], 'only the session and access checks are read');
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});
