import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

test('hybrid pool holdings, trades and collection links appear in the unified portfolio',
  { skip: !process.env.FLURBO_TEST_PLAYWRIGHT }, async () => {
    const { chromium } = await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
    const browser = await chromium.launch({ headless: true, executablePath: process.env.FLURBO_TEST_BROWSER });
    const pool = '0x' + '44'.repeat(20), wallet = '0x' + '11'.repeat(20), login = '0x' + '22'.repeat(20);
    const now = Math.floor(Date.now() / 1000), closesAt = now - 3600;
    const questions = ['Will the first block contain a transaction?', 'Will the second block contain a transaction?'];
    const markets = questions.map((question, eventIndex) => ({ id: `${pool}-${eventIndex}`, pool, poolTitle: 'Reality reader pool',
      eventIndex, question, route: 'reality', closesAt, observationEndsAt: closesAt + 600 }));
    const events = questions.map((question, index) => ({ id: `event-${index}`, question, route: 'reality', observationEndsAt: closesAt + 600 }));
    const held: Record<string, [string, string]> = { '3:8': ['2000000', '2000000'], '1:2': ['1000000', '0'] };
    const hash = (digit: string) => '0x' + digit.repeat(64);
    const trade = (index: number, scope: number, mask: string, quantity: string) => ({ name: 'Traded', hash: hash(String(index)), index,
      block: 100 + index, timestamp: now - 7200 + index, args: { trader: wallet, owner: wallet, scope, mask, isBuy: true, quantity, collateralAmount: quantity } });
    const paths: string[] = [], errors: string[] = [];
    let historyDown = false;
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      page.on('pageerror', (error: Error) => errors.push(error.message));
      await page.route('**/*', async (route: any) => {
        const path = new URL(route.request().url()).pathname;
        if (path.startsWith('/api/')) paths.push(path);
        if (path === '/api/auth/session') return route.fulfill({ json: { session: { address: login, method: 'passkey', expiresAt: Date.now() + 3600_000 } } });
        if (path === '/api/account/access') return route.fulfill({ json: { approved: true, testingTools: false } });
        if (path === '/api/account/wallets' || path === '/api/account/portfolio-sources')
          return route.fulfill({ json: { account: login, wallets: [wallet], agentWallets: [] } });
        if (path === '/api/market-directory') return route.fulfill({ json: { schema: 'flurbo.market-directory.v1', markets: [], oracleMarkets: [], hybridMarkets: markets } });
        if (path === `/api/hybrid/pool/${pool}/account`) return route.fulfill({ json: { schema: 'flurbo.hybrid-portfolio-account.v1',
          manifest: { pool, resolver: pool, chainId: 10143, publication: { draft: { title: 'Reality reader pool', closesAt, events } } },
          snapshot: { blockNumber: '200', blockHash: hash('a'), timestamp: now }, claimScopes: [3] } });
        if (path === `/api/hybrid/pool/${pool}/positions`) {
          const input = route.request().postDataJSON();
          return route.fulfill({ json: { schema: 'flurbo.hybrid-portfolio-positions.v1', owner: input.owner,
            snapshot: { blockNumber: '200', blockHash: hash('a'), timestamp: now }, resolved: true,
            rows: input.claims.map((claim: any) => { const [quantity, payoutAtoms] = input.owner === wallet && held[`${claim.scope}:${claim.mask}`] || ['0', '0'];
              return { scope: claim.scope, mask: claim.mask, quantity, payoutAtoms }; }) } });
        }
        if (path === `/api/hybrid/pool/${pool}/history` && historyDown) return route.fulfill({ status: 503, json: { error: 'History unavailable' } });
        if (path === `/api/hybrid/pool/${pool}/history`) return route.fulfill({ json: { complete: true, through: 200, target: 200,
          logs: [trade(1, 1, '2', '1000000'), trade(2, 3, '8', '2000000')] } });
        if (path === `/api/hybrid/pool/${pool}/collected-payouts`) return route.fulfill({ json: { complete: true, through: 200, target: 200, logs: [] } });
        if (path.startsWith('/api/')) return route.fulfill({ status: 503, json: { error: 'Unused' } });
        const relative = path.startsWith('/assets/') ? path.slice(1) : 'index.html';
        return route.fulfill({ body: await readFile(new URL('../dist/' + relative, import.meta.url)),
          contentType: relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.woff2') ? 'font/woff2' : 'text/html' });
      });
      await page.goto('https://flurbopm.singu.online/portfolio');
      const rows = page.locator('.unified-holdings tbody tr');
      await rows.nth(1).waitFor();
      assert.equal(await rows.count(), 2);
      const combined = rows.filter({ hasText: questions[0] }).filter({ hasText: questions[1] });
      assert.equal(await combined.count(), 1);
      const link = combined.getByRole('link', { name: 'Collect on market page' });
      assert.equal(await link.getAttribute('href'), `/markets/hybrid/${pool}/0?answer=yes&other=1&otherAnswer=yes&rule=AND`);
      assert.match(await combined.innerText(), /0x1111\.\.\.1111/);
      assert.match(await rows.filter({ hasText: 'Lost' }).innerText(), /Lost/);
      assert.match(await page.locator('.portfolio-summary-grid').innerText(), /Ready to collect\s*2/);
      assert.ok(paths.every(path => !path.startsWith('/api/hybrid-0x') && !path.startsWith('/api/pilot/')), paths.join(', '));
      await page.getByRole('button', { name: 'Activity', exact: true }).click();
      await page.getByRole('heading', { name: 'Your trades' }).waitFor();
      assert.equal(await page.getByRole('heading', { name: 'Indexed cash movement' }).count(), 0);
      assert.equal(await page.locator('.portfolio-activity tbody tr').count(), 2);
      historyDown = true;
      await page.reload();
      await page.getByRole('button', { name: 'Activity', exact: true }).click();
      await page.getByText('Saved activity, updating').waitFor();
      assert.equal(await page.locator('.portfolio-activity tbody tr').count(), 2);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
