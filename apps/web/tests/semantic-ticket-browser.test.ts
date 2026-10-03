import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { assessSemantics, semanticRegistry } from '../server/semantic-validation.mjs';
import { semanticAcknowledgment } from '../src/pilot.ts';
import { pilotFixture, owner, hash, code } from './pilot-fixture.ts';

// The V2 trade ticket with enforcement switched on in the fixture only: a reviewed conflict needs the
// exact typed acknowledgment for the current review, and a stale or failed re-check never reaches the wallet.
const namespace = 'practice-' + '22'.repeat(20);
test('trade ticket blocks a reviewed outcome conflict until acknowledged, and re-checks before the wallet', { skip: !process.env.FLURBO_TEST_PLAYWRIGHT }, async () => {
  const { chromium } = await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.FLURBO_TEST_BROWSER });
  const loginAddress = '0x' + '99'.repeat(20);
  const f = pilotFixture(Math.floor(Date.now() / 1000), 4);
  f.manifest.publication.draft.events.forEach((e: any, i: number) => e.question = ['Will the night market open?', 'Will the concert sell out?', 'Will it rain on Saturday?', 'Will the new cafe open?'][i]);
  f.manifest.publication.mode = 'rehearsal';
  f.options.allowance = 10n ** 12n; // skip the approval step; this test is about the purchase itself
  let mode: 'collide' | 'changed' | 'fail' = 'collide', linked = false;
  const checks: { path: string; body: any }[] = [], errors: string[] = [];
  const rules = () => semanticRegistry(JSON.stringify({ schema: 'flurbo.semantic-rules.v1', markets: [{ pool: f.manifest.pool, rulesHash: f.manifest.rulesHash, predicates: [
    { event: 0, observation: 'test:close', operator: 'gte', value: '3000', sourceRule: mode === 'changed' ? 'Fixture closing observation, revised.' : 'Fixture closing observation.' },
    { event: 1, observation: 'test:close', operator: 'lt', value: '2500', sourceRule: 'Fixture closing observation.' }] }] }));
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.addInitScript(({ owner, hash, code, namespace }: any) => {
      (window as any).ethereum = { isMetaMask: true, on() {}, removeListener() {}, request: async ({ method }: any) => {
        if (method === 'wallet_requestPermissions') return [];
        if (method === 'personal_sign') return '0x' + '11'.repeat(65);
        if (['eth_accounts', 'eth_requestAccounts'].includes(method)) return [owner];
        if (method === 'eth_chainId') return '0x279f';
        if (method === 'eth_getBlockByNumber') return { number: '0x65', hash };
        if (method === 'eth_getCode') return code;
        if (method === 'eth_call') return '0x';
        if (method === 'eth_estimateGas') return '0x186a0';
        if (method === 'eth_gasPrice') return '0x3b9aca00';
        if (method === 'eth_getBalance') return '0xde0b6b3a7640000';
        if (method === 'eth_getTransactionCount') return 121;
        if (method === 'eth_sendTransaction') {
          const pending = JSON.parse(localStorage.getItem('flurbo.' + namespace + '.pending.v1') || 'null');
          if (!pending || pending.hash !== null) throw new Error('Pending intent must be stored first');
          sessionStorage.setItem('pilot.sends', String(Number(sessionStorage.getItem('pilot.sends') || 0) + 1));
          return hash;
        }
        throw new Error(method);
      } };
    }, { owner, hash, code, namespace });
    await page.route('**/*', async (route: any) => {
      const url = new URL(route.request().url()), path = url.pathname;
      if (path === '/api/market-directory') return route.fulfill({ json: { schema: 'flurbo.market-directory.v1', active: namespace, markets: [{ namespace, label: 'September practice', pool: f.manifest.pool, closesAt: f.manifest.publication.draft.closesAt }] } });
      if (path === '/api/account/wallets') return route.fulfill({ json: { account: loginAddress, wallets: linked ? [owner] : [] } });
      if (path === '/api/account/portfolio-sources') return route.fulfill({ json: { account: loginAddress, wallets: linked ? [owner] : [], agentWallets: [] } });
      if (path === '/api/account/wallets/challenge') return route.fulfill({ json: { id: 'fixture-proof', message: 'Link this MetaMask wallet to your Flurbo account; no transaction.' } });
      if (path === '/api/account/wallets/verify') { linked = true; return route.fulfill({ json: { account: loginAddress, wallets: [owner] } }); }
      if (path === '/api/account/access') return route.fulfill({ json: { approved: true, testingTools: false } });
      if (path === '/api/auth/session') return route.fulfill({ json: { session: { address: loginAddress, method: 'passkey', expiresAt: Date.now() + 3600_000 } } });
      if (path === '/api/' + namespace + '/markets') return route.fulfill({ json: await f.service.markets() });
      if (path === '/api/' + namespace + '/status') return route.fulfill({ json: await f.service.status(url.searchParams.get('wallet') || undefined) });
      if (path.endsWith('/validate-trade')) {
        checks.push({ path, body: route.request().postDataJSON() });
        if (mode === 'fail') return route.fulfill({ status: 503, json: { code: 'SEMANTICS_UNAVAILABLE', error: 'The semantic check is unavailable. Retry before trading.' } });
        return route.fulfill({ json: assessSemantics(f.manifest, route.request().postDataJSON(), rules()) });
      }
      if (path === '/api/' + namespace + '/prepare') {
        const input = route.request().postDataJSON(), review = await f.service.prepare(input);
        if (input.action === 'buy') review.semanticAssessment = assessSemantics(f.manifest, { scope: input.scope, mask: input.mask, quantityAtoms: input.quantity }, rules());
        return route.fulfill({ json: review });
      }
      if (path === '/api/' + namespace + '/position') return route.fulfill({ json: { quantity: '0', payoutAtoms: null } });
      if (path === '/api/' + namespace + '/rpc') return route.fulfill({ json: { result: route.request().postDataJSON().method === 'eth_chainId' ? '0x279f' : { hash, number: '0x65' } } });
      if (path.startsWith('/api/')) return route.fulfill({ status: 503, json: { error: 'Unavailable fixture service' } });
      const relative = path.startsWith('/assets/') ? path.slice(1) : 'index.html';
      return route.fulfill({ body: await readFile(new URL('../dist/' + relative, import.meta.url)), contentType: relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.woff2') ? 'font/woff2' : 'text/html' });
    });

    await page.goto(`https://flurbo.singu.online/markets/${namespace}/0`);
    await page.getByRole('button', { name: /^(Connect MetaMask|Link selected wallet)$/ }).click();
    await page.getByRole('button', { name: 'Switch wallet', exact: true }).waitFor();
    // Both answers Yes on two questions that the reviewed rules make mutually exclusive.
    await page.getByRole('button', { name: /Combine with another prediction/ }).click();
    await page.getByRole('checkbox', { name: /Will the concert sell out\?/ }).check();
    const ticket = page.locator('.consumer-ticket'), buy = ticket.getByRole('button', { name: /^Buy 1 share$/ });
    const conflict = ticket.getByRole('region', { name: 'Outcome conflict' }), field = conflict.getByLabel(semanticAcknowledgment, { exact: true });
    const until = async (ok: () => Promise<boolean>) => { for (let i = 0; i < 200 && !(await ok()); i++) await page.waitForTimeout(25); assert.ok(await ok()); };
    await ticket.getByRole('button', { name: 'Refresh price', exact: true }).click();
    await conflict.getByRole('heading', { name: 'These outcomes cannot win together', exact: true }).waitFor();
    assert.equal(await buy.isDisabled(), true, 'a conflict keeps the purchase off until acknowledged');
    await field.fill('i understand this has no ordinary winning outcome');
    assert.equal(await buy.isDisabled(), true, 'the phrase must match exactly');
    assert.equal(await field.getAttribute('aria-invalid'), 'true');
    await field.fill(semanticAcknowledgment);
    assert.equal(await buy.isDisabled(), false);
    await conflict.getByText('Acknowledgment matches.', { exact: false }).waitFor();
    if (process.env.FLURBO_TEST_SCREENSHOT) await ticket.screenshot({ path: process.env.FLURBO_TEST_SCREENSHOT });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'the warning fits a phone screen');
    if (process.env.FLURBO_TEST_SCREENSHOT) await ticket.screenshot({ path: process.env.FLURBO_TEST_SCREENSHOT.replace('.png', '-mobile.png') });
    await page.setViewportSize({ width: 1440, height: 1000 });

    // A fresh price is a new review: the earlier acknowledgment does not carry over.
    await ticket.getByRole('button', { name: 'Refresh price', exact: true }).click();
    await until(async () => (await field.count()) === 1 && (await field.inputValue()) === '');
    assert.equal(await buy.isDisabled(), true);

    // Rules changed after the review: the pre-wallet re-check refuses, nothing is sent.
    await field.fill(semanticAcknowledgment);
    mode = 'changed';
    await buy.click();
    await ticket.locator('.ticket-status-error').getByText('These outcomes cannot win together under the configured rules. Review the payout warning before continuing.').waitFor();
    assert.equal(await page.evaluate(() => sessionStorage.getItem('pilot.sends')), null);
    assert.equal(await page.evaluate((ns: string) => localStorage.getItem('flurbo.' + ns + '.pending.v1'), namespace), null);

    // A failed check is never read as "no conflict" or "disabled".
    mode = 'fail';
    await ticket.getByRole('button', { name: 'Refresh price', exact: true }).click();
    await field.fill(semanticAcknowledgment);
    await buy.click();
    // The server's own 503 message is shown; the client never proceeds on it.
    await ticket.locator('.ticket-status-error').getByText(/check is unavailable\. Retry before/).waitFor();
    assert.equal(await page.evaluate(() => sessionStorage.getItem('pilot.sends')), null);

    // Current review, current rules, exact acknowledgment: the purchase reaches the wallet once.
    mode = 'collide';
    await ticket.getByRole('button', { name: 'Refresh price', exact: true }).click();
    await field.fill(semanticAcknowledgment);
    await buy.click();
    await page.waitForFunction(() => sessionStorage.getItem('pilot.sends') === '1');
    assert.ok(checks.length >= 3);
    assert.ok(checks.every(c => c.path === `/api/${namespace}/validate-trade`), 'the check uses the market namespace, never the default pilot');
    assert.deepEqual(Object.keys(checks.at(-1)!.body).sort(), ['mask', 'quantityAtoms', 'scope']);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
