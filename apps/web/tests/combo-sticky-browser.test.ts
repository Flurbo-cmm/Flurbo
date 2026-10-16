import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const pool = '0x' + '44'.repeat(20), account = '0x' + '22'.repeat(20), now = Math.floor(Date.now() / 1000);
const markets = Array.from({ length: 16 }, (_, eventIndex) => ({ id: `${pool}-${eventIndex}`, pool, poolTitle: 'Source pool', eventIndex,
  question: `Will reading number ${eventIndex + 1} be above the limit?`, route: 'mechanical', closesAt: now + 7200, observationEndsAt: now + 10800 }));

test('the ticket stays in view with the combine list open and chips add and remove', { skip: !process.env.FLURBO_TEST_PLAYWRIGHT }, async () => {
  const { chromium } = await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.FLURBO_TEST_BROWSER });
  const errors: string[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.route('**/*', async (route: any) => {
      const url = new URL(route.request().url()), path = url.pathname;
      if (path === '/api/auth/session') return route.fulfill({ json: { session: { address: account, method: 'passkey', expiresAt: Date.now() + 3600_000 } } });
      if (path === '/api/account/access') return route.fulfill({ json: { approved: true, testingTools: false } });
      if (path === '/api/account/wallets') return route.fulfill({ json: { account, wallets: [] } });
      if (path === '/api/account/portfolio-sources') return route.fulfill({ json: { account, wallets: [], agentWallets: [] } });
      if (path === '/api/market-directory') return route.fulfill({ json: { schema: 'flurbo.market-directory.v1', markets: [], oracleMarkets: [], hybridMarkets: markets } });
      if (path.endsWith('/market')) return route.fulfill({ json: { prices: { yes: '500000', no: '500000' }, marketNow: now, funded: true, resolved: false } });
      if (path.endsWith('/price-history')) return route.fulfill({ json: { pool, sampling: 'current', points: [] } });
      if (path.endsWith('/web')) return route.fulfill({ json: { schema: 'flurbo.hybrid-web.v1', pool, title: 'Source pool', closesAt: now + 7200, blockNumber: '1',
        blockHash: '0x' + '9'.repeat(64), observedAt: now, estimated: true, questions: markets.map(m => m.question), nodes: markets.map(m => ({ event: m.eventIndex, yes: 500 })), edges: [] } });
      if (path === `/api/hybrid/${pool}-0`) return route.fulfill({ json: { ...markets[0], schema: 'flurbo.hybrid-snapshot.v1', resolver: pool, eventHash: '0x' + '33'.repeat(32),
        rulesHash: '0x' + '55'.repeat(32), adapter: pool, source: { adapter: 'evm-rpc.v1', publisher: 'Test RPC' }, marketNow: now, funded: true, resolved: false, delivered: false,
        assertionDeadline: now + 14400, reportDeadline: now + 86400, bondAtoms: '1000000', phase: 0, proposal: 0, counter: 0, result: 0, challengeUntil: 0, arbitrationUntil: 0,
        requestId: '0x' + '00'.repeat(32), sourceCaseId: '0x' + '00'.repeat(32), proposalEvidenceURI: null, reality: null, user: null } });
      if (path.startsWith('/api/')) return route.fulfill({ status: 503, json: { error: 'Unavailable fixture' } });
      const relative = path.startsWith('/assets/') ? path.slice(1) : 'index.html';
      return route.fulfill({ body: await readFile(new URL('../dist/' + relative, import.meta.url)),
        contentType: relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.woff2') ? 'font/woff2' : 'text/html' });
    });
    await page.goto(`https://flurbo.singu.online/markets/hybrid/${pool}/0`);
    const ticket = page.getByRole('region', { name: 'Trade this market' });
    await ticket.waitFor();
    await page.locator('.oracle-combination summary').click();
    await page.getByRole('group', { name: 'Add a question' }).waitFor();
    await page.locator('.combo-add .choice-row', { hasText: 'number 3 ' }).click();
    await page.getByRole('list', { name: 'Questions in this combination' }).waitFor();
    await page.locator('.combo-add .choice-row', { hasText: 'number 5 ' }).click();
    assert.equal(await page.getByRole('group', { name: 'Add a question' }).count(), 0);
    await page.getByRole('button', { name: 'Remove Will reading number 3 be above the limit?' }).click();
    assert.equal(await page.locator('.combo-row').count(), 1);
    await page.getByRole('group', { name: 'Add a question' }).waitFor();
    const sidebar = await page.evaluate(() => { const e = document.querySelector('.market-sidebar')!; const c = getComputedStyle(e);
      return { sticky: c.position, overflow: c.overflowY, height: e.getBoundingClientRect().height, viewport: innerHeight, limit: parseFloat(c.maxHeight) }; });
    assert.equal(sidebar.sticky, 'sticky');
    assert.equal(sidebar.overflow, 'auto');
    assert.ok(sidebar.height <= sidebar.limit + 1 && sidebar.limit < sidebar.viewport, 'the ticket column fits inside the window and scrolls inside itself');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
