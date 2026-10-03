import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Optional production-bundle regression. All browser requests are intercepted;
// this fixture neither authenticates to the public site nor connects a wallet.
test('activity panels remain unique across repeated navigation and session restoration', {
  skip: !process.env.FLURBO_TEST_PLAYWRIGHT,
}, async () => {
  const { chromium } = await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.FLURBO_TEST_BROWSER });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.route('**/*', async (route: any) => {
      const path = new URL(route.request().url()).pathname;
      if(path==='/api/account/access')return route.fulfill({json:{approved:true,testingTools:true}});
      if (path === '/api/auth/session') return route.fulfill({ json: { session: {
        address: '0x2ff9ca4cb64fa82915144e8d9cf6a6ceddaa35e3', method: 'passkey', expiresAt: Date.now() + 3600000,
      } } });
      if (path.startsWith('/api/') || path === '/healthz') return route.fulfill({ status: 503, json: { error: 'Offline test fixture' } });
      const relative = path.startsWith('/assets/') ? path.slice(1) : 'index.html';
      const mime = relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.woff2') ? 'font/woff2' : 'text/html';
      return route.fulfill({ body: await readFile(new URL('../dist/' + relative, import.meta.url)), contentType: mime });
    });
    await page.goto('https://flurbo.singu.online/account');
    for (let i = 0; i < 6; i++) {
      await page.getByRole('button', { name: 'Activity & network', exact: true }).click();
      assert.equal(await page.locator('summary').filter({ hasText: 'Learning comparison' }).count(), 1);
      assert.equal(await page.locator('summary').filter({ hasText: 'Learning pool' }).count(), 1);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.locator('.workspace-sidebar').getByRole('link', { name: 'Portfolio', exact: true }).click();
      assert.equal(await page.locator('summary').filter({ hasText: 'Learning comparison' }).count(), 0);
      assert.equal(await page.locator('summary').filter({ hasText: 'Learning pool' }).count(), 0);
      await page.goto('https://flurbo.singu.online/account');
    }
    await page.getByRole('link', { name: 'Explore & trade', exact: true }).click();
    const selector = page.getByLabel('Market', { exact: true });
    await Promise.all([
      page.waitForRequest((req: any) => new URL(req.url()).pathname === '/api/markets/learning/state'),
      selector.selectOption('learning'),
    ]);
    await page.getByRole('link', { name: 'Explore & trade', exact: true }).click();
    assert.equal(await page.locator('.core-market .book').isVisible(), false);
    assert.equal(await page.getByText('H YES receipts', { exact: true }).isVisible(), false);
    assert.equal(await page.locator('#liability').locator('..').locator('.eyebrow').textContent(), 'COLLATERAL REQUIREMENT');
    await page.reload();
    await page.getByRole('button', { name: 'Activity & network', exact: true }).click();
    assert.equal(await selector.inputValue(), 'learning');
    await selector.selectOption('original');
    await page.getByRole('link', { name: 'Explore & trade', exact: true }).click();
    assert.equal(await page.locator('.core-market .book').isVisible(), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('portfolio deep links and the retired history route restore auth without reading retired holdings', {
  skip: !process.env.FLURBO_TEST_PLAYWRIGHT,
}, async () => {
  const { chromium } = await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.FLURBO_TEST_BROWSER });
  const account = '0x2ff9ca4cb64fa82915144e8d9cf6a6ceddaa35e3', other = '0x' + '11'.repeat(20);
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.addInitScript((account:string)=>sessionStorage.setItem('flurbo.view-wallet:'+account,account),account);
    let signedIn = true, indexing = true, requests = 0, interrupted = false, unavailable = false;
    const errors: string[] = [];
    page.on('pageerror', (e: Error) => errors.push(e.message));
    await page.route('**/*', async (route: any) => {
      const url = new URL(route.request().url()), path = url.pathname;
      if (path === '/api/market-directory') return route.fulfill({json:{schema:'flurbo.market-directory.v1',active:'practice-2222222222222222222222222222222222222222',markets:[]}});
      if(path==='/api/account/wallets'||path==='/api/account/portfolio-sources')return route.fulfill({json:{account:account,wallets:[account]}});
      if(path==='/api/account/access')return route.fulfill({json:{approved:true,testingTools:true}});
      if (path === '/api/auth/session') return route.fulfill({ json: { session: signedIn ? { address: account, method: 'passkey', expiresAt: Date.now() + 3600000 } : null } });
      if (path.startsWith('/api/') && path.endsWith('/portfolio')) {
        requests++;
        if (interrupted || unavailable) {
          interrupted = false;
          return route.fulfill({ status: 503, json: { error: 'eth_getCode: transport or JSON failure; remote details withheld' } });
        }
        const wallet = url.searchParams.get('wallet'), empty = wallet === other, learning = path.includes('/learning/');
        const complete = !indexing; indexing = false;
        if (!complete) interrupted = true;
        return route.fulfill({ json: {
          market_id: learning ? 'learning' : 'original', wallet_address: wallet, contracts: { pool: '0x' + '33'.repeat(20), cash: '0x' + '44'.repeat(20) },
          index: { complete, from_block: 100, through_block: complete ? 200 : 150, target_block: 200 },
          snapshot: { block_number: 200, stale: false, timestamp: Math.floor(Date.now() / 1000) },
          ausd_atoms: '9999999', receipt_atoms: learning ? null : '8000000', position_count: empty ? 0 : 2,
          positions: !complete ? null : empty ? [] : [
            { scope: 3, mask: 8, quantity_atoms: '2000000', settlement: 'pending', redeemable_atoms: null },
            { scope: 7, mask: 128, quantity_atoms: '3000000', settlement: 'winning', redeemable_atoms: '3000000' }],
          history_count: empty ? 0 : 21, page_size: 20,
          history: !complete ? null : empty ? [] : [{ kind: 'trade', is_buy: !url.searchParams.get('history_page') || url.searchParams.get('history_page') === '0', scope: 3, mask: '8', quantity_atoms: '1000000', collateral_atoms: '279955', block_number: 190, transaction_hash: '0x' + '55'.repeat(32), log_index: 0 }],
        } });
      }
      if (path.startsWith('/api/')) return route.fulfill({ status: 503, json: { error: 'Offline fixture' } });
      const relative = path.startsWith('/assets/') ? path.slice(1) : 'index.html';
      return route.fulfill({ body: await readFile(new URL('../dist/' + relative, import.meta.url)), contentType: relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.woff2') ? 'font/woff2' : 'text/html' });
    });
    await page.goto('https://flurbo.singu.online/portfolio');
    await page.getByRole('heading',{name:'Your shares',exact:true}).waitFor();
    assert.match(await page.title(), /portfolio/);
    assert.equal(await page.locator('.core-market').count(), 0);
    // The retired earlier demo and learning holdings are neither offered nor read.
    assert.equal(await page.getByText('Earlier experimental holdings').count(), 0);
    // History is retired. The old route must land on Portfolio.
    await page.goto('https://flurbo.singu.online/history');
    await page.waitForURL('**/portfolio');
    await page.getByRole('heading',{name:'Your shares',exact:true}).waitFor();
    // Consumer holdings come from verified links; there is no manual address lookup to confuse the account view.
    assert.equal(await page.getByText('Look up another address',{exact:true}).count(),0);
    await page.locator('.portfolio-account-identity').getByText(account,{exact:true}).waitFor();
    assert.equal(await page.getByLabel('Wallet to view').count(),0);
    assert.equal(requests, 0);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.FLURBO_TEST_SCREENSHOT) await page.screenshot({ path: process.env.FLURBO_TEST_SCREENSHOT.replace('.png', '-mobile.png'), fullPage: true });
    signedIn = false;
    for (const path of ['/portfolio', '/history']) {
      const before = requests;
      await page.goto('https://flurbo.singu.online' + path);
      await page.waitForURL('**/login');
      assert.equal(requests, before);
      assert.equal(await page.locator('.portfolio-view').count(), 0);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
