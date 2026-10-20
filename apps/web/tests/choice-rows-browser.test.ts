import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const questions: string[] = JSON.parse(await readFile(new URL('./fixtures/flb1-questions.json', import.meta.url), 'utf8'));
const pool = '0x' + '44'.repeat(20), account = '0x' + '22'.repeat(20), now = Math.floor(Date.now() / 1000);
const markets = questions.map((question, eventIndex) => ({ id: `${pool}-${eventIndex}`, pool, poolTitle: 'Source pool', eventIndex, question, route: 'reality',
  closesAt: now + 7200, observationEndsAt: now + 10800 }));

test('every question row shows its whole text, on the ticket and the thesis page, desktop and phone', { skip: !process.env.FLURBO_TEST_PLAYWRIGHT }, async () => {
  const { chromium } = await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.FLURBO_TEST_BROWSER });
  const errors: string[] = [];
  const measure = async (viewport: { width: number; height: number }, path: string, open: boolean) => {
    const page = await browser.newPage({ viewport });
    page.on('pageerror', (error: Error) => errors.push(error.message));
    try {
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
          blockHash: '0x' + '9'.repeat(64), observedAt: now, estimated: true, questions, nodes: markets.map(m => ({ event: m.eventIndex, yes: 500 })), edges: [] } });
        const m = path.match(/^\/api\/hybrid\/(0x[0-9a-fA-F]{40})-(\d+)$/);
        if (m) return route.fulfill({ json: { ...markets[Number(m[2])], schema: 'flurbo.hybrid-snapshot.v1', resolver: pool, eventHash: '0x' + '33'.repeat(32),
          rulesHash: '0x' + '55'.repeat(32), adapter: pool, source: { adapter: 'reality', publisher: 'Reality.eth' }, marketNow: now, funded: true, resolved: false, delivered: false,
          assertionDeadline: now + 14400, reportDeadline: now + 86400, bondAtoms: '1000000', phase: 0, proposal: 0, counter: 0, result: 0, challengeUntil: 0, arbitrationUntil: 0,
          requestId: '0x' + '00'.repeat(32), sourceCaseId: '0x' + '00'.repeat(32), proposalEvidenceURI: null, reality: null, user: null } });
        if (path.startsWith('/api/')) return route.fulfill({ status: 503, json: { error: 'Unavailable fixture' } });
        const relative = path.startsWith('/assets/') ? path.slice(1) : 'index.html';
        return route.fulfill({ body: await readFile(new URL('../dist/' + relative, import.meta.url)),
          contentType: relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.woff2') ? 'font/woff2' : 'text/html' });
      });
      await page.goto(`https://flurbo.singu.online${path}`);
      if (open) { await page.locator('.oracle-combination summary').click(); await page.locator('.choice-row').first().waitFor(); }
      else await page.locator('.choice-row').first().waitFor();
      return await page.$$eval('.choice-row', els => els.map(e => ({ client: e.clientHeight, scroll: e.scrollHeight,
        markTop: e.querySelector('.choice-mark')!.getBoundingClientRect().top - e.getBoundingClientRect().top })));
    } finally { await page.close(); }
  };
  try {
    const cases = [
      { name: 'ticket desktop', viewport: { width: 1440, height: 900 }, path: `/markets/hybrid/${pool}/0`, open: true },
      { name: 'ticket phone', viewport: { width: 390, height: 844 }, path: `/markets/hybrid/${pool}/0`, open: true },
      { name: 'thesis desktop', viewport: { width: 1440, height: 1100 }, path: `/markets/hybrid/${pool}/0/thesis`, open: false },
    ];
    for (const item of cases) {
      const rows = await measure(item.viewport, item.path, item.open);
      assert.ok(rows.length >= 14, `${item.name}: ${rows.length} rows`);
      for (const row of rows) {
        assert.ok(row.scroll <= row.client + 1, `${item.name}: row text fits its box (client ${row.client}, scroll ${row.scroll})`);
        assert.ok(row.markTop >= 0 && row.markTop < 24, `${item.name}: mark sits on the first line (${row.markTop})`);
      }
      assert.ok(rows.some(row => row.client > 48), `${item.name}: wrapped questions make taller rows`);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
