import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

test('old practice market links open the hybrid market page; retired pilot links show Market not found', { skip: !process.env.FLURBO_TEST_PLAYWRIGHT }, async () => {
  const { chromium } = await import(pathToFileURL(process.env.FLURBO_TEST_PLAYWRIGHT!).href);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.FLURBO_TEST_BROWSER });
  const hex = '22'.repeat(20), pool = '0x' + hex, account = '0x' + '33'.repeat(20), now = Math.floor(Date.now() / 1000);
  const markets = ['Will the test block contain a transaction?', 'Will the test block use gas?'].map((question, eventIndex) => ({ id: `${pool}-${eventIndex}`,
    pool, poolTitle: 'Source pool', eventIndex, question, route: 'mechanical', closesAt: now + 7200, observationEndsAt: now + 10800 }));
  const namespaceReads: string[] = [], errors: string[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.route('**/*', async (route: any) => {
      const url = new URL(route.request().url()), path = url.pathname;
      if (path.startsWith('/api/pilot/') || path.startsWith('/api/practice-')) namespaceReads.push(path);
      if (path === '/api/auth/session') return route.fulfill({ json: { session: { address: account, method: 'passkey', expiresAt: Date.now() + 3600_000 } } });
      if (path === '/api/account/access') return route.fulfill({ json: { approved: true, testingTools: false } });
      if (path === '/api/account/wallets') return route.fulfill({ json: { account, wallets: [] } });
      if (path === '/api/account/portfolio-sources') return route.fulfill({ json: { account, wallets: [], agentWallets: [] } });
      if (path === '/api/market-directory') return route.fulfill({ json: { schema: 'flurbo.market-directory.v1',
        markets: [{ namespace: 'practice-' + hex, label: 'Source pool', pool, closesAt: now + 7200 }], oracleMarkets: [], hybridMarkets: markets } });
      const hybrid = path.match(/^\/api\/hybrid\/(0x[0-9a-f]{40}-[01])(?:\/(market|price-history))?$/);
      if (hybrid) {
        const market = markets.find(m => m.id === hybrid[1])!;
        if (hybrid[2] === 'market') return route.fulfill({ json: { schema: 'flurbo.hybrid-market.v1', id: market.id, pool, marketNow: now, funded: true, resolved: false, prices: { yes: '500000', no: '500000' } } });
        if (hybrid[2] === 'price-history') return route.fulfill({ json: { pool, sampling: 'current', points: [{ timestamp: now, blockNumber: '1', prices: [{ event: 0, yes: '500000', no: '500000' }] }] } });
        return route.fulfill({ json: { ...market, schema: 'flurbo.hybrid-snapshot.v1', resolver: pool, eventHash: '0x' + '33'.repeat(32),
          rulesHash: '0x' + '55'.repeat(32), adapter: pool, source: { adapter: 'evm-rpc.v1', publisher: 'Test RPC' },
          marketNow: now, funded: true, resolved: false, delivered: false, assertionDeadline: now + 14400, reportDeadline: now + 86400, bondAtoms: '1000000',
          phase: 0, proposal: 0, counter: 0, result: 0, challengeUntil: 0, arbitrationUntil: 0,
          requestId: '0x' + '00'.repeat(32), sourceCaseId: '0x' + '00'.repeat(32), proposalEvidenceURI: null, reality: null, user: null } });
      }
      if (path.startsWith('/api/')) return route.fulfill({ status: 503, json: { error: 'Unavailable fixture service' } });
      const relative = path.startsWith('/assets/') ? path.slice(1) : 'index.html';
      return route.fulfill({ body: await readFile(new URL('../dist/' + relative, import.meta.url)), contentType: relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.woff2') ? 'font/woff2' : 'text/html' });
    });
    await page.goto(`https://flurbo.singu.online/markets/practice-${hex}/1`);
    await page.waitForURL(`**/markets/hybrid/${pool}/1`);
    await page.getByRole('heading', { name: 'Will the test block use gas?', exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, `/markets/hybrid/${pool}/1`);
    await page.goto(`https://flurbo.singu.online/markets/practice-${hex}/0/thesis`);
    await page.waitForURL(`**/markets/hybrid/${pool}/0/thesis`);
    await page.goto('https://flurbo.singu.online/markets/pilot/0');
    await page.getByRole('heading', { name: 'Market not found', exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/markets/pilot/0');
    assert.deepEqual(namespaceReads, []);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
